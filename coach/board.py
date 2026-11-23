"""App state and the board operations.

The same operations serve three callers: the UI (HTTP routes in server.py), Claude inside the app
(in-process tools in chat.py) and Claude Code outside the app (coach/mcp_server.py over HTTP).
Every change is pushed to the open windows over SSE via `broadcast`.
"""

import asyncio
import json
import os
import time
from pathlib import Path

import anyio
import chess

from . import explain, history, scenes
from .config import DATA, PUZZLES
from .engine import ENGINE
from .scenes import SceneError

MAX_SCENES = 300


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    os.replace(tmp, path)


class Store:
    def __init__(self) -> None:
        self.study = load_json(DATA / "scenes.json", {"scenes": [], "current": None, "seq": 0})
        self.study["scenes"] = [s if "root" in s else scenes.from_old(s) for s in self.study["scenes"]]
        self.progress = load_json(DATA / "progress.json", {})
        self.settings = load_json(DATA / "settings.json", {"mode": "puzzle", "filter": {"kind": "all", "phase": "all", "color": "all"}})
        self.view: dict = {}
        self.clients: set[asyncio.Queue] = set()
        self.lock: str | None = None  # set by lichess.py while a live game is on: no analysis, no Claude
        self.reload_puzzles()

    def reload_puzzles(self) -> None:
        self.puzzles_raw = PUZZLES.read_bytes() if PUZZLES.exists() else b"[]"
        self.puzzles = {p["id"]: p for p in json.loads(self.puzzles_raw)}

    def save_study(self) -> None:
        save_json(DATA / "scenes.json", self.study)

    def save_settings(self) -> None:
        save_json(DATA / "settings.json", self.settings)


S = Store()


async def broadcast(event: dict) -> None:
    for q in list(S.clients):
        q.put_nowait(event)


# Boards kept outside scenes.json — the repertoire's two trees (coach/repertoire.py registers itself here):
# found by id, saved with their own file, and a move under which a repertoire section starts cannot be deleted.
EXTERNAL = {"find": lambda sid: None, "save": lambda sc: None, "guard_delete": lambda sc, node_id: None}


def save_scene(sc: dict) -> None:
    if sc.get("rep"):
        EXTERNAL["save"](sc)
    else:
        S.save_study()


# ---------------- helpers ----------------
def scene(sid: str | None = None) -> dict:
    sid = sid or S.view.get("sceneId") or S.study["current"]
    if (ext := EXTERNAL["find"](sid)) is not None:
        return ext
    for s in S.study["scenes"]:
        if s["id"] == sid:
            return s
    raise SceneError(f"no diagram {sid!r}" if sid else "no diagram on the board yet — create one with show")


def find_scene(sid: str | None) -> dict | None:
    if (ext := EXTERNAL["find"](sid)) is not None:
        return ext
    return next((s for s in S.study["scenes"] if s["id"] == sid), None) if sid else None


# A board belongs to one chat (sc["chat"]); a chat may have several boards, the user switches between them.
# The chat's active board (S.settings["chat_boards"][chat]) is the one its Claude works on by default:
# the board of that chat the user switched to last, or the one Claude made or picked last.
def chat_scenes(chat_id: str | None) -> list[dict]:
    return [s for s in S.study["scenes"] if chat_id and s.get("chat") == chat_id]


def chat_scene(chat_id: str | None, sid: str | None = None) -> dict | None:
    """A board of the chat: `sid` (an error if it is not this chat's), else its active board, else its latest."""
    own = chat_scenes(chat_id)
    if sid:
        sc = next((s for s in own if s["id"] == sid), None)
        if sc is None:
            ids = ", ".join(f"{s['id']} «{s['title']}»" for s in own) or "none yet"
            raise SceneError(f"board {sid!r} is not one of this chat's boards ({ids})")
        return sc
    active = (S.settings.get("chat_boards") or {}).get(chat_id)
    return next((s for s in own if s["id"] == active), None) or (own[-1] if own else None)


async def set_chat_board(chat_id: str, sid: str) -> None:
    boards = S.settings.setdefault("chat_boards", {})
    if boards.get(chat_id) == sid:
        return
    boards[chat_id] = sid
    S.save_settings()
    await broadcast({"type": "chat_board", "chat": chat_id, "scene": sid})


async def note_view(prev_sid: str | None, sid: str | None) -> None:
    """The window switched boards: a board of a chat becomes that chat's active board.
    Only a switch counts, so a late report of the old board does not undo Claude's new one."""
    sc = find_scene(sid) if sid != prev_sid else None
    if sc and sc.get("chat"):
        await set_chat_board(sc["chat"], sc["id"])


async def bind_chat(sc: dict, chat_id: str) -> None:
    if sc.get("rep"):  # a repertoire tree belongs to no chat (its lessons are chats of its sections)
        return
    sc["chat"] = chat_id
    S.save_study()
    await broadcast({"type": "scene", "scene": sc, "goto": None})
    await set_chat_board(chat_id, sc["id"])


async def unbind_chat(chat_id: str) -> None:
    """A deleted chat leaves its boards without a chat; the next question about one starts a new chat."""
    if (S.settings.get("chat_boards") or {}).pop(chat_id, None):
        S.save_settings()
    for sc in S.study["scenes"]:
        if sc.get("chat") == chat_id:
            sc.pop("chat")
            S.save_study()
            await broadcast({"type": "scene", "scene": sc, "goto": None})


def resolve(sc: dict, at, create: bool = False) -> dict:
    """`at`: None/'start' | 'current' (the node the user is looking at) | node id | move path."""
    if at == "current":
        if S.view.get("sceneId") == sc["id"] and S.view.get("nodeId"):
            try:
                return scenes.find(sc, S.view["nodeId"])
            except SceneError:
                pass
        return sc["root"]
    return scenes.find(sc, at, create=create)


def node_info(sc: dict, node: dict) -> dict:
    path = scenes.path_of(sc, node["id"])
    return {"node": node["id"], "path": scenes.path_text(path) or "(start)", "fen": node["fen"]}


def tree_text(sc: dict) -> str:
    return scenes.pgn(sc, with_ids=True) or "(no moves yet)"


def current_fen() -> str | None:
    return S.view.get("fen")


def backfill_history() -> None:
    """Boards made before they kept the moves that led to them: look those up in the stored games (at server start)."""
    todo = [sc for sc in S.study["scenes"] if "history" not in sc]
    if not todo:
        return
    for sc in todo:
        sc["history"] = history.find(sc["root"]["fen"])
    S.save_study()


# ---------------- operations ----------------
async def op_show(b: dict) -> dict:
    """A new board; with `chat`, one more board of that chat (its active one now); the chat's other boards stay as they are."""
    S.study["seq"] += 1
    sc, first = scenes.make_scene(f"s{S.study['seq']}", b, current_fen())
    if "history" not in sc:
        sc["history"] = await asyncio.to_thread(history.find, sc["root"]["fen"])
    for key in ("puzzle", "lpuzzle", "chat", "game"):  # where it came from: app.js boardHome puts it in that mode
        if b.get(key):
            sc[key] = b[key]
    S.study["scenes"].append(sc)
    S.study["scenes"] = S.study["scenes"][-MAX_SCENES:]
    S.study["current"] = sc["id"]
    S.save_study()
    goto = sc["root"]
    if b.get("goto"):
        goto = scenes.find(sc, b["goto"])
    if sc.get("chat"):
        await set_chat_board(sc["chat"], sc["id"])
    await broadcast({"type": "scene", "scene": sc, "goto": goto["id"]})
    return {"ok": True, "scene": sc["id"], "showing": node_info(sc, goto)["path"], "tree": tree_text(sc)}


async def op_add_line(b: dict) -> dict:
    sc = scene(b.get("scene"))
    start = resolve(sc, b.get("at"), create=True)
    nodes = scenes.add_moves(sc, start, b.get("moves") or [], by=b.get("by", "claude"), title=b.get("title") or "",
                             comment=b.get("comment") or "", shapes=b.get("shapes"))
    save_scene(sc)
    target = nodes[0] if nodes else start
    if b.get("goto") == "end" and nodes:
        target = nodes[-1]
    await broadcast({"type": "scene", "scene": sc, "goto": target["id"] if b.get("goto", True) else None})
    return {"ok": True, "scene": sc["id"], "first": node_info(sc, target), "last": node_info(sc, nodes[-1] if nodes else start), "tree": tree_text(sc)}


async def op_annotate(b: dict) -> dict:
    sc = scene(b.get("scene"))
    node = resolve(sc, b.get("at", "current"))
    if b.get("title"):
        sc["title"] = b["title"]
    if b.get("comment") is not None:
        node["comment"] = (node.get("comment", "") + "\n\n" + b["comment"]).strip() if b.get("append") else b["comment"]
    if b.get("shapes") is not None:
        new = scenes.parse_shapes(b["shapes"])
        node["shapes"] = (node.get("shapes", []) + new) if b.get("append") else new
    if "glyph" in b and node["id"] != "root":
        scenes.set_glyph(node, b.get("glyph") or "")
    save_scene(sc)
    await broadcast({"type": "scene", "scene": sc, "goto": node["id"] if b.get("goto", True) else None})
    return {"ok": True, **node_info(sc, node)}


async def op_goto(b: dict) -> dict:
    sc = scene(b.get("scene"))
    node = resolve(sc, b.get("at"))
    S.study["current"] = sc["id"]
    await broadcast({"type": "goto", "scene": sc["id"], "node": node["id"]})
    return {"ok": True, **node_info(sc, node)}


async def op_edit(b: dict) -> dict:
    sc = scene(b.get("scene"))
    node = resolve(sc, b.get("at", "current"))
    action = b.get("action")
    goto = node["id"]
    if action == "promote":
        scenes.promote(sc, node["id"])
    elif action == "delete":
        if sc.get("rep"):
            EXTERNAL["guard_delete"](sc, node["id"])
        goto = scenes.delete(sc, node["id"])["id"]
    else:
        raise SceneError("action must be 'promote' or 'delete'")
    save_scene(sc)
    await broadcast({"type": "scene", "scene": sc, "goto": goto})
    return {"ok": True, "tree": tree_text(sc)}


async def op_user_move(b: dict) -> dict:
    """A move the user played on the board: becomes a branch of the tree (Lichess behaviour)."""
    sc = scene(b.get("scene"))
    parent = scenes.find(sc, b.get("at") or "root")
    nodes = scenes.add_moves(sc, parent, [b["uci"]], by="user")
    save_scene(sc)
    await broadcast({"type": "scene", "scene": sc, "goto": None, "origin": b.get("client")})
    return {"ok": True, "node": nodes[0]["id"], "scene": sc}


async def op_delete_scene(b: dict) -> dict:
    if EXTERNAL["find"](b.get("id")) is not None:
        raise SceneError("a repertoire tree cannot be deleted")
    S.study["scenes"] = [s for s in S.study["scenes"] if s["id"] != b.get("id")]
    if S.study["current"] == b.get("id"):
        S.study["current"] = S.study["scenes"][-1]["id"] if S.study["scenes"] else None
    S.save_study()
    await broadcast({"type": "scenes"})
    return {"ok": True}


async def op_mode(b: dict) -> dict:
    mode = b.get("mode")
    if mode not in ("study", "puzzle"):
        raise SceneError("mode must be 'study' or 'puzzle'")
    pid = b.get("puzzle")
    if pid and pid not in S.puzzles:
        raise SceneError(f"unknown puzzle {pid!r}")
    S.settings["mode"] = mode
    S.save_settings()
    await broadcast({"type": "mode", "mode": mode, "puzzle": pid})
    return {"ok": True}


def fmt_eval(info: dict) -> str:
    if info["mate"] is not None:
        return f"mate in {info['mate']}" if info["mate"] > 0 else f"gets mated in {-info['mate']}"
    return f"{info['cp'] / 100:+.2f}"


async def op_analyse(b: dict) -> dict:
    """Stockfish lines. For Claude: SAN text; for the UI (b['ui']) also UCI and white-POV numbers."""
    board = scenes.parse_position(b.get("position") or "current", current_fen())
    multipv = max(1, min(int(b.get("lines") or 3), 8))
    seconds = max(0.1, min(float(b.get("seconds") or 1.5), 20))
    if board.is_game_over():
        return {"fen": board.fen(), "game_over": board.result(), "lines": []}

    def run():
        me = board.turn
        res: dict = {"fen": board.fen(), "side_to_move": "white" if me else "black", "lines": []}
        for info in ENGINE.analyse(board, seconds=seconds, multipv=multipv):
            plies = explain.walk(board, info["pv"][:16], me)
            line = {"eval": fmt_eval(info), "win_pct": info["win"], "moves": explain.line_text(plies)}
            if b.get("ui"):
                sign = 1 if me == chess.WHITE else -1
                line.update(
                    uci=[p["uci"] for p in plies], san=[p["san"] for p in plies],
                    cp_white=None if info["cp"] is None else sign * info["cp"],
                    mate_white=None if info["mate"] is None else sign * info["mate"],
                    win_white=info["win"] if me == chess.WHITE else round(100 - info["win"], 1),
                )
            res["lines"].append(line)
        if b.get("threat"):
            t = explain.threat(board.fen(), me, res["lines"][0]["win_pct"] if res["lines"] else 50.0)
            res["threat"] = (explain.threat_phrase(t) + ": " + explain.line_text(t["plies"][:6])) if t else "no serious threat"
        return res

    return await anyio.to_thread.run_sync(run)


def op_summary(_: dict | None = None) -> dict:
    """What the user sees right now, in a form Claude can read."""
    v = S.view
    out: dict = {"app_open": bool(S.clients), "mode": v.get("mode") or S.settings.get("mode")}
    fen = v.get("fen")
    if fen:
        b = chess.Board(fen)
        out["board"] = {
            "fen": fen,
            "side_to_move": "white" if b.turn else "black",
            "orientation": v.get("orientation"),
            "diagram": str(b),
            "user_arrows": v.get("userShapes") or [],
            "engine_panel_on": bool(v.get("engineOn")),
        }
    if out["mode"] == "study":
        if v.get("host"):  # a board of «Игра» / «Задачи» on screen there (a game's review, a puzzle's position, your boards)
            out["shown_in"] = {"play": "Игра", "puzzle": "Задачи"}.get(v["host"], v["host"])
        try:
            sc = scene(v.get("sceneId"))
            node = resolve(sc, "current")
            out["study"] = {
                **({"repertoire_tree": sc["rep"], "repertoire_section": v.get("section")} if sc.get("rep") else {}),
                "scene": sc["id"],
                "title": sc["title"],
                "start_fen": sc["root"]["fen"],
                "comment": sc["root"]["comment"],
                "tree": tree_text(sc),
                "current": {**node_info(sc, node), "comment": node.get("comment", "")},
                "user_branches": scenes.user_branches(sc),
            }
        except SceneError:
            out["study"] = None
        out["recent_diagrams"] = [{"id": s["id"], "title": s["title"]} for s in S.study["scenes"][-8:]]
    pz = v.get("puzzle")
    if out["mode"] == "puzzle" and v.get("lpuzzle"):
        out["lichess_puzzle"] = v["lpuzzle"]  # a rated puzzle from Lichess (coach/lichess_puzzles.py)
    elif out["mode"] == "puzzle" and pz and pz.get("id") in S.puzzles:
        out["puzzle"] = puzzle_summary(S.puzzles[pz["id"]], pz)
    return out


def puzzle_summary(p: dict, pz: dict) -> dict:
    board = chess.Board(p["fen"])
    bw = explain.best_w(p)

    def san(u):
        return board.san(chess.Move.from_uci(u))

    def line(u):
        return explain.line_text(explain.walk(board, [chess.Move.from_uci(x) for x in [u, *p["moves"][u][1]]], board.turn))

    top = sorted(p["moves"].items(), key=lambda kv: -kv[1][0])[:6]
    return {
        "id": p["id"],
        "kind": "blunder (user erred here in the game)" if p["kind"] == "blunder" else "missed (opponent just blundered, user did not punish)",
        "fen": p["fen"],
        "side_to_move": "white" if board.turn else "black",
        "diagram": str(board),
        "opponent_last_move": p.get("lastSan"),
        "game": f"https://lichess.org/{p['game']}/{p['color']}#{p['ply'] - 1}",
        "played_in_game": {"move": p["playedSan"], "win_pct": p["moves"][p["played"]][0], "line": line(p["played"])},
        "best": {"move": san(p["best"]), "win_pct": bw, "line": line(p["best"])},
        "top_moves": [{"move": san(u), "win_pct": m[0]} for u, m in top],
        "user_attempts": [{"move": san(u), "win_pct": p["moves"][u][0], "ok": bw - p["moves"][u][0] <= explain.PASS}
                          for u in pz.get("attempts", []) if u in p["moves"]],
        "hint_used": pz.get("hinted", False),
        "solution_shown": pz.get("solution", False),
        "progress": S.progress.get(p["id"]),
    }


def op_puzzles_info(b: dict) -> dict | list:
    action = b.get("action", "stats")
    now = time.time() * 1000
    prog = S.progress
    allp = list(S.puzzles.values())
    if action == "stats":
        seen = [i for i in prog if i in S.puzzles]
        return {
            "total": len(allp),
            "kinds": {k: sum(p["kind"] == k for p in allp) for k in ("blunder", "missed")},
            "seen": len(seen),
            "due_now": sum(prog[i]["due"] <= now for i in seen),
            "learned_box3plus": sum(prog[i].get("box", 0) >= 3 for i in seen),
            "solved_total": sum(prog[i].get("ok", 0) for i in seen),
            "failed_total": sum(prog[i].get("fail", 0) for i in seen),
        }
    if action == "failing":
        rows = sorted((i for i in prog if i in S.puzzles and prog[i].get("fail")), key=lambda i: (-prog[i]["fail"], prog[i].get("ok", 0)))
        return [
            {"id": i, "fail": prog[i]["fail"], "ok": prog[i].get("ok", 0), "kind": S.puzzles[i]["kind"], "phase": S.puzzles[i]["phase"],
             "fen": S.puzzles[i]["fen"], "game_move": S.puzzles[i]["playedSan"], "opening": S.puzzles[i]["opening"]}
            for i in rows[:20]
        ]
    raise SceneError("action must be stats | failing")


async def op_puzzles(b: dict):
    action = b.get("action", "stats")
    if action == "open":
        if not b.get("id"):
            raise SceneError("open needs id")
        return await op_mode({"mode": "puzzle", "puzzle": b["id"]})
    if action == "resume":
        return await op_mode({"mode": "puzzle"})
    return op_puzzles_info(b)


OPS = {
    "board_state": lambda b: op_summary(b),
    "show": op_show,
    "add_line": op_add_line,
    "annotate": op_annotate,
    "goto": op_goto,
    "edit": op_edit,
    "analyse": op_analyse,
    "puzzles": op_puzzles,
}


async def call_op(name: str, args: dict):
    if S.lock:  # Claude (in the app or in Claude Code outside) gets nothing during a live game
        raise SceneError(S.lock)
    fn = OPS.get(name)
    if fn is None:
        raise SceneError(f"unknown operation {name!r}")
    res = fn(args)
    if asyncio.iscoroutine(res):
        res = await res
    return res
