"""How hard a puzzle from the user's games is for a player of their level — judged by Maia.

Maia (https://maiachess.com, CSSLab, GPL-3.0) is a net trained on Lichess games of people of one rating: it does not
pick the best move, it predicts the move such a player makes. Its policy gives each legal move a probability; the
sum over the moves that hold the position (within PASS win% of the best, as the trainer judges) is the chance that a
LEVEL player finds the answer. That chance becomes a puzzle rating on the Elo scale: a LEVEL player is expected to
solve a puzzle rated R with probability 1 / (1 + 10^((R - LEVEL) / 400)).

Runs on lc0 (brew install lc0) with the weights of scripts/fetch_maia.sh in the data folder; without them puzzles
simply have no rating. The position goes in with the game's moves before it: Maia looks at the last 8 positions.
Kept free of app imports: scripts/make_puzzles.py imports it.
"""

import math
import re
import subprocess

import chess
import chess.engine

from .config import MAIA, lc0

LEVEL = 1300  # the Maia net used: about the user's rapid rating (Maia nets exist for 1100…1900)
PASS = 8  # same as scripts/make_puzzles.py and coach/explain.py
_P = re.compile(r"^(\S+)\s+\(\s*\d+\s*\)\s+N:.*\(P:\s*([\d.]+)%\)")


def weights():
    w = MAIA / f"maia-{LEVEL}.pb.gz"
    return w if w.exists() else None


def available() -> bool:
    return bool(lc0() and weights())


def rating(p: float) -> int:
    """The puzzle rating at which a LEVEL player solves it with probability p."""
    p = min(max(p, 0.03), 0.97)
    return round(LEVEL + 400 * math.log10((1 - p) / p))


class Maia:
    def __init__(self) -> None:
        w, exe = weights(), lc0()
        if not (w and exe):
            raise RuntimeError("Maia needs lc0 (brew install lc0) and its weights (scripts/fetch_maia.sh)")
        self.engine = chess.engine.SimpleEngine.popen_uci(exe, stderr=subprocess.DEVNULL)
        # temperature 1: the net's own probabilities (lc0 flattens them to widen its search by default)
        self.engine.configure({"WeightsFile": str(w), "VerboseMoveStats": True, "PolicyTemperature": 1.0})

    def policy(self, board: chess.Board) -> dict[str, float]:
        """uci → probability that a LEVEL player plays it."""
        out = {}
        with self.engine.analysis(board, chess.engine.Limit(nodes=1)) as a:
            for info in a:
                m = _P.match(info.get("string", ""))
                if m and m[1] != "node":
                    out[m[1]] = float(m[2]) / 100
        return out

    def chance(self, board: chess.Board, moves: dict) -> float:
        """Chance of a move within PASS of the best; moves = the puzzle's {uci: [win%, line]}."""
        best = max(w for w, _ in moves.values())
        good = {u for u, (w, _) in moves.items() if best - w <= PASS}
        pol = self.policy(board)
        # lc0 names castling king-takes-rook (e1h1); python-chess and the puzzles use e1g1
        pol = {board.uci(m): pol.get(m.uci(), pol.get(_lc0_castle(board, m), 0.0)) for m in board.legal_moves}
        total = sum(pol.values()) or 1.0
        return sum(v for u, v in pol.items() if u in good) / total

    def close(self) -> None:
        self.engine.quit()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _lc0_castle(board: chess.Board, m: chess.Move) -> str:
    if not board.is_castling(m):
        return ""
    rook = chess.H1 if chess.square_file(m.to_square) == 6 else chess.A1
    if board.turn == chess.BLACK:
        rook = chess.square_mirror(rook)
    return chess.square_name(m.from_square) + chess.square_name(rook)
