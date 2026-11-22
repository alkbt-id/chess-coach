"""Summarise data/analysis/moves.jsonl: accuracy, error counts by phase and clock,
thrown games, unpunished opponent errors."""

import collections
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from coach.config import NO_USER, lichess_user

MOVES = ROOT / "data/analysis/moves.jsonl"
GAMES = ROOT / "data/lichess/games.ndjson"
USER = lichess_user() or sys.exit(NO_USER)

# Lichess thresholds, in win-percent points lost by one move.
INACC, MISTAKE, BLUNDER = 5, 10, 15


def accuracy(loss: float) -> float:
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1669))


def phase(r: dict) -> str:
    if r["move_no"] <= 12 and r["material"] > 46:
        return "opening"
    if r["material"] <= 26:
        return "endgame"
    return "middlegame"


def kind(loss: float) -> str | None:
    if loss >= BLUNDER:
        return "blunder"
    if loss >= MISTAKE:
        return "mistake"
    if loss >= INACC:
        return "inaccuracy"
    return None


def main():
    games = {g["id"]: g for g in map(json.loads, GAMES.open())}
    rows = [json.loads(line) for line in MOVES.open()]
    by_game = collections.defaultdict(list)
    for r in rows:
        by_game[r["game"]].append(r)

    def result(gid):
        g = games[gid]
        side = "white" if g["players"]["white"].get("user", {}).get("id") == USER else "black"
        w = g.get("winner")
        return side, ("D" if w is None else "W" if w == side else "L")

    user = [r for r in rows if r["is_user"]]
    opp = [r for r in rows if not r["is_user"]]
    n_games = len(by_game)
    print(f"games analysed: {n_games}, user moves: {len(user)}")
    print(f"avg accuracy  you: {sum(accuracy(r['win_loss']) for r in user) / len(user):.1f}"
          f"   opponents: {sum(accuracy(r['win_loss']) for r in opp) / len(opp):.1f}")
    for who, rs in (("you", user), ("opp", opp)):
        c = collections.Counter(kind(r["win_loss"]) for r in rs)
        print(f"per game {who}: inacc {c['inaccuracy'] / n_games:.1f}  mistakes {c['mistake'] / n_games:.1f}"
              f"  blunders {c['blunder'] / n_games:.1f}")

    print("\n== errors by phase (per 100 of your moves)")
    for ph in ("opening", "middlegame", "endgame"):
        rs = [r for r in user if phase(r) == ph]
        c = collections.Counter(kind(r["win_loss"]) for r in rs)
        if rs:
            print(f"{ph:11} moves {len(rs):5}  mistakes {100 * c['mistake'] / len(rs):4.1f}"
                  f"  blunders {100 * c['blunder'] / len(rs):4.1f}"
                  f"  acc {sum(accuracy(r['win_loss']) for r in rs) / len(rs):.1f}")

    print("\n== errors by your clock (per 100 moves)")
    buckets = [(0, 30), (30, 60), (60, 120), (120, 300), (300, 10_000)]
    for lo, hi in buckets:
        rs = [r for r in user if r["clock_cs"] is not None and lo <= r["clock_cs"] / 100 < hi]
        c = collections.Counter(kind(r["win_loss"]) for r in rs)
        if rs:
            print(f"{lo:4}-{hi:<5}s moves {len(rs):5}  mistakes {100 * c['mistake'] / len(rs):4.1f}"
                  f"  blunders {100 * c['blunder'] / len(rs):4.1f}")

    print("\n== first big error (>=15) — at which move, histogram")
    first = []
    for gid, rs in by_game.items():
        for r in rs:
            if r["is_user"] and r["win_loss"] >= BLUNDER:
                first.append(r["move_no"])
                break
    hist = collections.Counter(min(m // 5 * 5, 50) for m in first)
    for k in sorted(hist):
        print(f"moves {k:2}-{k + 4:2}: {'#' * hist[k]} {hist[k]}")

    print("\n== thrown games: you had >=80% win chance but did not win")
    thrown = []
    for gid, rs in by_game.items():
        side, res = result(gid)
        peak = max((r["win_after"] for r in rs if r["is_user"]), default=0)
        if peak >= 80 and res != "W":
            thrown.append((gid, res, peak))
    lost = sum(1 for _, res in map(result, by_game) if res == "L")
    print(f"{len(thrown)} of {lost} losses/draws-from-winning: "
          f"{sum(1 for t in thrown if t[1] == 'L')} lost, {sum(1 for t in thrown if t[1] == 'D')} drawn")

    print("\n== opponent blunders (>=15) you did not punish (your next move lost >=10 back)")
    missed = total = 0
    for gid, rs in by_game.items():
        for a, b in zip(rs, rs[1:]):
            if not a["is_user"] and a["win_loss"] >= BLUNDER and b["is_user"]:
                total += 1
                if b["win_loss"] >= MISTAKE:
                    missed += 1
    print(f"{missed} of {total} ({100 * missed / max(total, 1):.0f}%)")

    print("\n== your blunders: what the opponent's best reply was")
    reply = collections.Counter()
    for gid, rs in by_game.items():
        for a, b in zip(rs, rs[1:]):
            best = b["best"]
            if a["is_user"] and a["win_loss"] >= BLUNDER and best:
                reply["mate/check" if "+" in best or "#" in best else "capture" if "x" in best else "quiet"] += 1
    print(dict(reply))


if __name__ == "__main__":
    main()
