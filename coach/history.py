"""The moves that led to a board's start position, so a line written up to it («после 5...Bg7») is clickable too.

A board made from moves keeps them (scenes.make_scene). A board made from a FEN looks the position up in the
user's games (config.GAMES): Claude usually shows a position from one of them and then names the move before it.
"""

import contextlib
import json

import chess

from . import config

VARIANTS = (None, "standard", "fromPosition")  # games with the normal rules
_index: dict = {"mtime": None, "games": [], "pos": {}}


def _key(board: chess.Board) -> str:
    return " ".join(board.fen().split()[:4])  # pieces, side to move, castling, en passant


def _build() -> dict:
    """Every position of the stored games -> (game, plies played); the newest game wins (re-read when the file changes)."""
    try:
        mtime = config.GAMES.stat().st_mtime
    except OSError:
        return {}
    if _index["mtime"] == mtime:
        return _index["pos"]
    games = []
    for line in config.GAMES.open():
        with contextlib.suppress(ValueError):
            games.append(json.loads(line))
    games.sort(key=lambda g: -g.get("createdAt", 0))
    kept, pos = [], {}
    for g in games:
        if g.get("variant") not in VARIANTS:
            continue
        start = g.get("initialFen") or chess.STARTING_FEN
        try:
            b = chess.Board(start)
        except ValueError:
            continue
        moves: list[str] = []
        for san in (g.get("moves") or "").split():
            try:
                m = b.parse_san(san)
            except ValueError:
                break
            b.push(m)
            moves.append(m.uci())
            pos.setdefault(_key(b), (len(kept), len(moves)))
        kept.append((start, g.get("id"), moves))
    _index.update(mtime=mtime, games=kept, pos=pos)
    return pos


def find(fen: str) -> dict:
    """{start, moves (UCI), game} of a stored game that reaches `fen`; {} when none does."""
    try:
        key = _key(chess.Board(fen))
    except ValueError:
        return {}
    hit = _build().get(key)
    if not hit:
        return {}
    start, gid, moves = _index["games"][hit[0]]
    return {"start": start, "moves": moves[: hit[1]], "game": gid}
