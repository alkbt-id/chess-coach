"""One shared Stockfish process for the app (explanations and analysis requests from Claude)."""

import math
import threading

import chess
import chess.engine

from . import config

STOCKFISH = config.stockfish()


def win_pct(cp: int) -> float:
    """Lichess formula: centipawns (side to move POV) -> win chance 0..100."""
    cp = max(-1000, min(1000, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


class Engine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._e: chess.engine.SimpleEngine | None = None

    def _engine(self) -> chess.engine.SimpleEngine:
        e = self._e
        if e is None:
            e = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
            e.configure({"Threads": 4, "Hash": 128})
            self._e = e
        return e

    def analyse(self, board: chess.Board, *, nodes: int | None = None, seconds: float | None = None, multipv: int = 1) -> list[dict]:
        """Top lines for the side to move: [{cp, mate, win, pv: [Move]}], best first."""
        limit = chess.engine.Limit(nodes=nodes, time=seconds) if (nodes or seconds) else chess.engine.Limit(nodes=500_000)
        with self._lock:
            try:
                infos = self._engine().analyse(board, limit, multipv=multipv)
            except chess.engine.EngineTerminatedError:
                self._e = None  # restart once if Stockfish died
                infos = self._engine().analyse(board, limit, multipv=multipv)
        out = []
        for info in infos:
            score = info["score"].pov(board.turn)
            out.append(
                {
                    "cp": score.score(),
                    "mate": score.mate(),
                    "win": round(win_pct(score.score(mate_score=100_000)), 1),
                    "pv": list(info.get("pv", [])),
                }
            )
        return out

    def close(self) -> None:
        with self._lock:
            if self._e is not None:
                try:
                    self._e.quit()
                except Exception:
                    pass
                self._e = None


ENGINE = Engine()
