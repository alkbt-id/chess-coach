"""Run Stockfish over every move of the user's rated standard games.

Input:  data/lichess/games.ndjson (Lichess API export)
Output: data/analysis/moves.jsonl — one line per ply with eval before/after,
        best move and the player's win-chance loss.
"""

import json
import math
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import chess
import chess.engine

ROOT = Path(__file__).resolve().parent.parent
GAMES = ROOT / "data/lichess/games.ndjson"
OUT = ROOT / "data/analysis/moves.jsonl"
USER = "alkbtz"
STOCKFISH = "/opt/homebrew/bin/stockfish"
NODES = 400_000
WORKERS = 14

_local = threading.local()
_engines: list[chess.engine.SimpleEngine] = []


def win_pct(cp: int) -> float:
    """Lichess formula: centipawns (side to move POV) -> win chance 0..100."""
    cp = max(-1000, min(1000, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def engine() -> chess.engine.SimpleEngine:
    """One Stockfish process per worker thread (threads, not processes: a
    process pool hangs on exit because SimpleEngine keeps a live thread)."""
    e = getattr(_local, "engine", None)
    if e is None:
        e = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
        e.configure({"Threads": 1, "Hash": 64})
        _local.engine = e
        _engines.append(e)
    return e


def analyse_game(game: dict) -> list[dict]:
    board = chess.Board()
    sans = game["moves"].split()
    user_white = game["players"]["white"].get("user", {}).get("id") == USER
    clocks = game.get("clocks", [])
    evals = []  # white POV centipawns, one per position (len = plies + 1)
    bests = []
    positions = []
    for i in range(len(sans) + 1):
        positions.append(board.fen())
        if board.is_game_over():
            outcome = board.outcome()
            if outcome.winner is None:
                evals.append(0)
            else:
                evals.append(100_000 if outcome.winner == chess.WHITE else -100_000)
            bests.append(None)
        else:
            info = engine().analyse(board, chess.engine.Limit(nodes=NODES))
            evals.append(info["score"].white().score(mate_score=100_000))
            pv = info.get("pv") or [None]
            bests.append(board.san(pv[0]) if pv[0] else None)
        if i < len(sans):
            board.push_san(sans[i])

    rows = []
    board = chess.Board()
    for i, san in enumerate(sans):
        mover_white = i % 2 == 0
        sign = 1 if mover_white else -1
        before = win_pct(sign * evals[i])
        after = win_pct(sign * evals[i + 1])
        npm = sum(
            len(board.pieces(pt, c)) * v
            for pt, v in ((chess.KNIGHT, 3), (chess.BISHOP, 3), (chess.ROOK, 5), (chess.QUEEN, 9))
            for c in (chess.WHITE, chess.BLACK)
        )
        rows.append(
            {
                "game": game["id"],
                "ply": i + 1,
                "move_no": i // 2 + 1,
                "color": "white" if mover_white else "black",
                "is_user": mover_white == user_white,
                "fen": positions[i],
                "san": san,
                "best": bests[i],
                "eval_before": evals[i],
                "eval_after": evals[i + 1],
                "win_before": round(before, 1),
                "win_after": round(after, 1),
                "win_loss": round(max(0.0, before - after), 1),
                "clock_cs": clocks[i] if i < len(clocks) else None,
                "material": npm,
            }
        )
        board.push_san(san)
    return rows


def main():
    games = [json.loads(line) for line in GAMES.open()]
    games = [g for g in games if g.get("rated") and g["variant"] == "standard" and g.get("moves")]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # incremental: games already in moves.jsonl are kept, only new ones are analysed
    done_ids = {json.loads(line)["game"] for line in OUT.open()} if OUT.exists() else set()
    games = [g for g in games if g["id"] not in done_ids]
    print(f"{len(done_ids)} games already analysed, {len(games)} new", file=sys.stderr, flush=True)
    if not games:
        print("done: nothing new to analyse")
        return
    done = 0
    with OUT.open("a") as f, ThreadPoolExecutor(WORKERS) as pool:
        for rows in pool.map(analyse_game, games):
            for r in rows:
                f.write(json.dumps(r) + "\n")
            done += 1
            if done % 5 == 0 or done == len(games):
                print(f"{done}/{len(games)}", file=sys.stderr, flush=True)
    for e in _engines:
        e.quit()
    print(f"done: {len(games)} games -> {OUT}")


if __name__ == "__main__":
    main()
