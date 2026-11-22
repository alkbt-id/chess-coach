"""Turn the user's own errors into training positions.

Two kinds:
  blunder — position before your move that lost >=15 win% points ("don't blunder")
  missed  — opponent just blundered (>=15) and your reply gave >=10 back ("punish it")

Every legal move in each position is scored by Stockfish, so the trainer can
judge any move the player tries, not only the engine's first choice.

Input:  data/analysis/moves.jsonl, data/lichess/games.ndjson
Output: trainer/puzzles.json
"""

import datetime
import json
import math
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import chess
import chess.engine

ROOT = Path(__file__).resolve().parent.parent
MOVES = ROOT / "data/analysis/moves.jsonl"
GAMES = ROOT / "data/lichess/games.ndjson"
OUT = ROOT / "trainer/puzzles.json"
USER = "alkbtz"
STOCKFISH = "/opt/homebrew/bin/stockfish"
NODES = 250_000
WORKERS = 14
PASS = 8  # a move within this many win% points of the best one counts as solved

_local = threading.local()
_engines: list[chess.engine.SimpleEngine] = []


def win_pct(cp: int) -> float:
    cp = max(-1000, min(1000, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def engine() -> chess.engine.SimpleEngine:
    """One Stockfish process per worker thread (threads, not processes: a
    process pool hangs on exit because SimpleEngine keeps a live thread)."""
    e = getattr(_local, "engine", None)
    if e is None:
        e = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
        e.configure({"Threads": 1, "Hash": 32})
        _local.engine = e
        _engines.append(e)
    return e


def phase(move_no: int, material: int) -> str:
    if move_no <= 12 and material > 46:
        return "opening"
    if material <= 26:
        return "endgame"
    return "middlegame"


def score_moves(task: dict) -> dict | None:
    board = chess.Board(task["fen"])
    me = board.turn
    moves = {}
    for mv in list(board.legal_moves):
        board.push(mv)
        if board.is_checkmate():
            w, pv = 100.0, []
        elif board.is_game_over():
            w, pv = 50.0, []
        else:
            info = engine().analyse(board, chess.engine.Limit(nodes=NODES))
            w = win_pct(info["score"].pov(me).score(mate_score=100_000))
            pv = [m.uci() for m in info.get("pv", [])[:8]]
        board.pop()
        moves[mv.uci()] = [round(w, 1), pv]
    best_w = max(w for w, _ in moves.values())
    played = task["played"]
    if best_w - moves[played][0] < PASS + 2:
        return None  # engine no longer thinks the game move was clearly worse
    # keep long lines only where they teach something: the best moves and the game move
    for uci, (w, pv) in moves.items():
        if best_w - w > PASS and uci != played:
            moves[uci] = [w, pv[:4]]
    task["moves"] = moves
    task["best"] = max(moves, key=lambda u: moves[u][0])
    return task


def main():
    games = {g["id"]: g for g in map(json.loads, GAMES.open())}
    by_game = {}
    for r in map(json.loads, MOVES.open()):
        by_game.setdefault(r["game"], []).append(r)

    tasks = []
    for gid, rows in by_game.items():
        g = games[gid]
        color = "white" if g["players"]["white"].get("user", {}).get("id") == USER else "black"
        opp = g["players"]["black" if color == "white" else "white"]
        for i, r in enumerate(rows):
            if not r["is_user"]:
                continue
            prev = rows[i - 1] if i > 0 else None
            missed = prev is not None and prev["win_loss"] >= 15 and r["win_loss"] >= 10
            blunder = r["win_loss"] >= 15 and r["win_before"] >= 25
            if not (missed or blunder):
                continue
            board = chess.Board(r["fen"])
            last = None
            if prev is not None:
                pb = chess.Board(prev["fen"])
                last = pb.parse_san(prev["san"]).uci()
            tasks.append(
                {
                    "id": f"{gid}-{r['ply']}",
                    "kind": "missed" if missed else "blunder",
                    "fen": r["fen"],
                    "color": color,
                    "last": last,
                    "lastSan": prev["san"] if prev else None,
                    "played": board.parse_san(r["san"]).uci(),
                    "playedSan": r["san"],
                    "moveNo": r["move_no"],
                    "phase": phase(r["move_no"], r["material"]),
                    "game": gid,
                    "ply": r["ply"],
                    "date": datetime.date.fromtimestamp(g["createdAt"] / 1000).isoformat(),
                    "opp": opp.get("user", {}).get("name", "?"),
                    "oppRating": opp.get("rating"),
                    "opening": g.get("opening", {}).get("name", ""),
                }
            )
    # incremental: puzzles already built are kept, only new positions are scored
    old = json.loads(OUT.read_text()) if OUT.exists() else []
    have = {p["id"] for p in old}
    tasks = [t for t in tasks if t["id"] not in have]
    print(f"{len(have)} puzzles exist, {len(tasks)} new candidate positions", file=sys.stderr, flush=True)

    out = list(old)
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, t in enumerate(pool.map(score_moves, tasks), 1):
            if t:
                out.append(t)
            if n % 10 == 0 or n == len(tasks):
                print(f"{n}/{len(tasks)}", file=sys.stderr, flush=True)
    for e in _engines:
        e.quit()
    out.sort(key=lambda t: (t["date"], t["ply"]), reverse=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    kinds = {k: sum(1 for t in out if t["kind"] == k) for k in ("blunder", "missed")}
    print(f"done: {len(out)} puzzles {kinds} -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
