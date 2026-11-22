"""Game reviews, like Lichess's computer analysis: Stockfish looks at every move of one of the user's
games and the game becomes a diagram of the analysis board with ?! / ? / ?? on the inaccuracies,
mistakes and blunders, the better line as a variation and a summary for both sides.

Games come from the user's history (config.GAMES, refreshed by the fetch_games job) or
from a game just played in the app (coach/live.py). Reviews never run during a live game (S.lock).
"""

import asyncio
import contextlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import chess
import chess.engine

from . import config, jobs, live, scenes
from .board import MAX_SCENES, S, broadcast
from .engine import STOCKFISH, win_pct
from .lichess import ACCOUNT

GAMES = config.GAMES
NODES = 400_000  # as scripts/analyze.py
WORKERS = 6
# Lichess's judgement thresholds: a drop of the mover's winning chances by 15 / 10 / 5 percentage points
JUDGEMENTS = [(15, "??", "Зевок"), (10, "?", "Ошибка"), (5, "?!", "Неточность")]
SIDE = {"white": "белые", "black": "чёрные"}
_one = asyncio.Semaphore(1)  # one review at a time: each uses several Stockfish processes
_tasks: dict[str, asyncio.Task] = {}


class ReviewError(ValueError):
    pass


def _my_color(players: dict) -> str:
    ids = {((players.get(c) or {}).get("user") or {}).get("id", "").lower(): c for c in ("white", "black")}
    for who in (config.lichess_user(), (ACCOUNT.user() or "").lower()):
        if who and who in ids:  # "" is the id of an AI opponent
            return ids[who]
    return "white"


# ---------------- the user's games ----------------
_cache: dict = {"mtime": None, "games": []}


def stored_games() -> list[dict]:
    """games.ndjson, newest first (re-read when the file changes)."""
    try:
        mtime = GAMES.stat().st_mtime
    except OSError:
        return []
    if _cache["mtime"] != mtime:
        games = []
        for line in GAMES.open():
            with contextlib.suppress(ValueError):
                games.append(json.loads(line))
        _cache.update(mtime=mtime, games=sorted(games, key=lambda g: -g.get("createdAt", 0)))
    return _cache["games"]


def _players(g: dict) -> dict:
    """Both sides of a stored game, for the review board: {white: {name, rating}, black: {name, rating}}."""
    out = {}
    for side in ("white", "black"):
        p = (g.get("players") or {}).get(side) or {}
        name = (p.get("user") or {}).get("name") or (f"Компьютер, уровень {p['aiLevel']}" if p.get("aiLevel") else "?")
        out[side] = {"name": name, "rating": p.get("rating")}
    return out


def _summary(g: dict) -> dict:
    """A stored Lichess game -> one row of the history list."""
    players = g.get("players", {})
    color = _my_color(players)
    mine, opp = players.get(color, {}), players.get("black" if color == "white" else "white", {})
    winner = g.get("winner")
    clock = g.get("clock") or {}
    return {
        "id": g["id"], "date": g.get("createdAt"), "color": color, "rated": g.get("rated"), "speed": g.get("speed"),
        "tc": f"{clock['initial'] // 60}+{clock['increment']}" if clock else "",
        "opp": (opp.get("user") or {}).get("name") or (f"Компьютер, уровень {opp['aiLevel']}" if opp.get("aiLevel") else "?"),
        "oppRating": opp.get("rating"), "rating": mine.get("rating"), "diff": mine.get("ratingDiff"),
        "result": "draw" if not winner else ("win" if winner == color else "loss"), "status": g.get("status"),
        "opening": (g.get("opening") or {}).get("name", ""), "plies": len((g.get("moves") or "").split()),
        "players": _players(g),
    }


def _live_summary(lg) -> dict:
    p = lg.public()
    opp = p["black" if p["color"] == "white" else "white"]
    return {
        "id": p["id"], "date": int(lg.started * 1000), "color": p["color"], "rated": p["rated"], "speed": p["speed"],
        "tc": f"{p['clock']['initial'] // 60000}+{p['clock']['increment'] // 1000}" if p["clock"] else "",
        "opp": opp["name"], "oppRating": opp["rating"], "rating": p[p["color"]]["rating"], "diff": p["ratingDiff"],
        "result": "draw" if not p["winner"] else ("win" if p["winner"] == p["color"] else "loss"), "status": p["status"],
        "opening": "", "plies": len(p["moves"]),
        "players": {side: {"name": p[side]["name"], "rating": p[side]["rating"]} for side in ("white", "black")},
    }


def reviewed() -> dict[str, dict]:
    """Lichess game id -> its review diagram: {scene, state}."""
    out = {}
    for sc in S.study["scenes"]:
        gid = (sc.get("game") or {}).get("lichess")
        if gid:
            out[gid] = {"scene": sc["id"], "state": (sc.get("review") or {}).get("state")}
    return out


def history(offset: int = 0, limit: int = 30) -> dict:
    rows = [_summary(g) for g in stored_games() if g.get("variant", "standard") == "standard"]
    known = {r["id"] for r in rows}
    fresh = [_live_summary(g) for g in live.L.games.values() if not g.playing and g.id not in known and g.moves()]
    rows = sorted(fresh, key=lambda r: -r["date"]) + rows
    done = reviewed()
    for r in rows[offset:offset + limit]:
        r["review"] = done.get(r["id"])
    return {"total": len(rows), "games": rows[offset:offset + limit], "fetching": any(j.status == "running" and j.kind == "fetch_games" for j in jobs.JOBS.values())}


async def refresh() -> None:
    """New games from Lichess into games.ndjson (the background fetch job)."""
    if not any(j.status == "running" for j in jobs.JOBS.values()):
        await jobs.start("fetch_games")


# ---------------- one game -> a diagram ----------------
def _game_source(gid: str) -> dict:
    """Moves and players of a game: one just played in the app, else the stored history."""
    lg = live.L.games.get(gid)
    if lg is not None and lg.moves():
        if lg.playing:
            raise ReviewError("партия ещё идёт")
        s = _live_summary(lg)
        return {**s, "start": lg.start_fen(), "moves": [m["uci"] for m in lg.moves()]}
    for g in stored_games():
        if g["id"] == gid:
            if g.get("variant", "standard") != "standard":
                raise ReviewError("разбор есть только для обычных шахмат")
            return {**_summary(g), "start": chess.STARTING_FEN, "moves": (g.get("moves") or "").split()}
    raise ReviewError(f"партии {gid} нет в истории — обнови список партий")


def _title(s: dict) -> str:
    date = datetime.fromtimestamp(s["date"] / 1000).strftime("%d.%m") if s.get("date") else ""
    rating = f" ({s['oppRating']})" if s.get("oppRating") else ""
    result = {"win": "победа", "loss": "поражение", "draw": "ничья"}[s["result"]]
    return " · ".join(x for x in (f"{s['opp']}{rating}", s.get("tc"), date, result) if x)


def backfill_players() -> None:
    """Review boards made before they kept both players: add them from the stored games (at server start)."""
    todo = {sc["game"]["lichess"]: sc for sc in S.study["scenes"]
            if (sc.get("game") or {}).get("lichess") and "players" not in sc["game"]}
    if not todo:
        return
    for g in stored_games():
        if g["id"] in todo:
            todo[g["id"]]["game"]["players"] = _players(g)
    S.save_study()


async def start(gid: str) -> dict:
    """Open the game's review diagram; Stockfish starts on it unless it has run already."""
    if S.lock:
        raise ReviewError(S.lock)
    have = reviewed().get(gid)
    sc = next((x for x in S.study["scenes"] if have and x["id"] == have["scene"]), None)
    if sc is not None and "review" not in sc:  # made by the first version (moves only): bring title and game data up to date
        with contextlib.suppress(ReviewError):
            src = _game_source(gid)
            sc["title"] = _title(src)
            sc["game"] = {**sc["game"], "result": src["result"], "status": src["status"],
                          "url": f"https://lichess.org/{gid}/{src['color']}", "opening": src.get("opening", ""),
                          "players": src["players"]}
    if sc is None:
        src = _game_source(gid)
        S.study["seq"] += 1
        sc = scenes.new_scene(f"s{S.study['seq']}", _title(src), src["start"], src["color"],
                              comment="Stockfish разбирает партию…")
        scenes.add_moves(sc, sc["root"], src["moves"], by="game")
        sc["game"] = {"lichess": gid, "color": src["color"], "result": src["result"], "status": src["status"],
                      "url": f"https://lichess.org/{gid}/{src['color']}", "opening": src.get("opening", ""),
                      "players": src["players"]}
        S.study["scenes"].append(sc)
        S.study["scenes"] = S.study["scenes"][-MAX_SCENES:]
    S.study["current"] = sc["id"]
    if (sc.get("review") or {}).get("state") != "done" and not (sc["id"] in _tasks and not _tasks[sc["id"]].done()):
        sc["review"] = {"state": "queued", "done": 0, "total": len(_main_line(sc)) + 1}
        _tasks[sc["id"]] = asyncio.create_task(_run(sc))
    S.save_study()
    await broadcast({"type": "scene", "scene": sc, "goto": "root"})
    return {"scene": sc["id"], "state": sc["review"]["state"]}


def _main_line(sc: dict) -> list[dict]:
    out, node = [], sc["root"]
    while node["children"]:
        node = node["children"][0]
        out.append(node)
    return out


# ---------------- Stockfish over the game ----------------
def _analyse(fen: str, engines: list, local: threading.local) -> dict:
    board = chess.Board(fen)
    if board.is_checkmate():
        return {"win": 0.0, "cp": None, "mate": 0, "pv": []}
    if board.is_game_over():
        return {"win": 50.0, "cp": 0, "mate": None, "pv": []}
    e = getattr(local, "engine", None)
    if e is None:
        e = local.engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
        e.configure({"Threads": 1, "Hash": 64})
        engines.append(e)
    info = e.analyse(board, chess.engine.Limit(nodes=NODES))
    score = info["score"].pov(board.turn)
    return {"win": round(win_pct(score.score(mate_score=100_000)), 1), "cp": score.score(), "mate": score.mate(),
            "pv": [m.uci() for m in info.get("pv", [])[:10]]}


def _white_eval(res: dict, white_to_move: bool) -> str:
    """Lichess-style evaluation from White's side: +0.45, −1.20, #3, #−2."""
    sign = 1 if white_to_move else -1
    if res["mate"] is not None:
        return f"#{sign * res['mate']}" if res["mate"] else "#"
    cp = sign * (res["cp"] or 0)
    return f"{cp / 100:+.2f}".replace("-", "−")


async def _run(sc: dict) -> None:
    rv = sc["review"]
    async with _one:
        nodes = _main_line(sc)
        fens = [sc["root"]["fen"]] + [n["fen"] for n in nodes]
        rv.update(state="running", total=len(fens), done=0)
        await broadcast({"type": "scene", "scene": sc, "goto": None})
        loop = asyncio.get_running_loop()
        engines: list = []
        local = threading.local()
        results: list[dict | None] = [None] * len(fens)
        ex = ThreadPoolExecutor(WORKERS)

        async def one(i: int, fen: str):
            return i, await loop.run_in_executor(ex, _analyse, fen, engines, local)

        tasks = [asyncio.create_task(one(i, f)) for i, f in enumerate(fens)]
        try:
            last = 0.0
            for coro in asyncio.as_completed(tasks):
                i, res = await coro
                results[i] = res
                rv["done"] += 1
                if S.lock:  # a live game started: no engine now
                    rv["state"] = "stopped"
                    break
                if time.time() - last > 0.8:
                    last = time.time()
                    await broadcast({"type": "scene", "scene": sc, "goto": None})
        except Exception as e:  # noqa: BLE001 — the window must learn that it failed
            rv.update(state="failed", error=str(e) or type(e).__name__)
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.to_thread(ex.shutdown, wait=True, cancel_futures=True)  # then no thread starts an engine
            for e in engines:
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(e.quit)
        if rv["state"] == "running" and all(r is not None for r in results):
            _annotate(sc, nodes, results)
            rv["state"] = "done"
        elif rv["state"] == "running":
            rv["state"] = "failed"
        S.save_study()
        await broadcast({"type": "scene", "scene": sc, "goto": None})


def _annotate(sc: dict, nodes: list[dict], res: list[dict]) -> None:
    color = sc["game"]["color"]
    count = {"white": {"?!": 0, "?": 0, "??": 0}, "black": {"?!": 0, "?": 0, "??": 0}}
    mine: list[str] = []
    parent = sc["root"]
    for i, node in enumerate(nodes):
        board = chess.Board(parent["fen"])
        mover = "white" if board.turn == chess.WHITE else "black"
        before, after = res[i], res[i + 1]
        node["eval"] = _white_eval(after, not board.turn)  # the position after this move, White's view
        best = before["pv"][0] if before["pv"] else None
        loss = before["win"] - (100 - after["win"])
        judged = next(((g, name) for t, g, name in JUDGEMENTS if loss >= t), None) if best and best != node["uci"] else None
        if judged:
            glyph, name = judged
            count[mover][glyph] += 1
            best_san = board.san(chess.Move.from_uci(best))
            node["glyph"] = glyph
            node["comment"] = (f"{name}. Лучше было {node['num']}{best_san} "
                               f"({_white_eval(before, board.turn)} → {node['eval']}).")
            with contextlib.suppress(scenes.SceneError):
                scenes.add_moves(sc, parent, before["pv"][:8], by="engine", title="Stockfish")
            if mover == color:
                mine.append(f"{node['num']}{node['san']}{glyph}")
        parent = node

    def row(side: str) -> str:
        c = count[side]
        return f"| {'Ты' if side == color else 'Соперник'} ({SIDE[side]}) | {c['?!']} | {c['?']} | {c['??']} |"

    g = sc["game"]
    result = {"win": "победа", "loss": "поражение", "draw": "ничья"}.get(g.get("result"), "")
    lines = [
        f"**Разбор Stockfish.** Твой цвет — {SIDE[color]}{f', итог — {result}' if result else ''}."
        + (f" Дебют: {g['opening']}." if g.get("opening") else ""),
        "",
        "| | Неточности ?! | Ошибки ? | Зевки ?? |",
        "|---|---|---|---|",
        row(color),
        row("black" if color == "white" else "white"),
        "",
        (f"Твои ошибки и зевки: {', '.join(m for m in mine if not m.endswith('?!'))}." if any(not m.endswith("?!") for m in mine)
         else "Ошибок и зевков у тебя нет."),
        "Нажми на ход со значком — под ним объяснение, а вариант «Stockfish» показывает, что было лучше.",
    ]
    sc["root"]["comment"] = "\n".join(lines)


def mark_interrupted() -> None:
    """After a restart: a review that was running is no longer."""
    for sc in S.study["scenes"]:
        rv = sc.get("review")
        if rv and rv.get("state") in ("running", "queued"):
            rv["state"] = "stopped"


mark_interrupted()
