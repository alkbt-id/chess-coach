"""PGN files in «Разбор»: the list of a file's games and one game as a board.

The window reads the file (or takes pasted text) and sends its text; nothing is kept here. A file with one game
opens straight on a board, with several the window shows the list (`games`) and opens the one picked (`scene`).
The board is the game's whole tree: variations, comments ([%cal] / [%csl] arrows become shapes, [%clk] and other
commands are dropped) and the ?! ? !! ?? !? ! marks.
"""

import hashlib
import io
import re

import chess
import chess.pgn

from . import config, scenes
from .scenes import SceneError

MAX_TEXT = 20_000_000  # characters: a big database is fine to list, not to send around forever
MAX_LIST = 5000
NAG_GLYPH = {1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!"}
BRUSH = {"green": "green", "red": "red", "yellow": "yellow", "blue": "blue"}
COMMAND_RE = re.compile(r"\[%[^\]]*\]")
RESULT = {"1-0": "1-0", "0-1": "0-1", "1/2-1/2": "½-½"}


def _text(text: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise SceneError("пустой PGN")
    if len(text) > MAX_TEXT:
        raise SceneError("файл слишком большой")
    return text.lstrip("﻿")


def _name(h, side: str) -> str:
    v = (h.get(side) or "").strip()
    return "" if v in ("", "?") else v


def _row(i: int, h) -> dict:
    date = (h.get("Date") or h.get("UTCDate") or "").replace("??", "").strip(".")
    return {"i": i, "white": _name(h, "White"), "black": _name(h, "Black"),
            "white_elo": (h.get("WhiteElo") or "").strip("?"), "black_elo": (h.get("BlackElo") or "").strip("?"),
            "result": RESULT.get(h.get("Result", ""), ""), "event": _name(h, "Event"), "date": date,
            "opening": _name(h, "Opening") or _name(h, "ECO"), "chapter": _name(h, "ChapterName")}


def games(text: str) -> list[dict]:
    """The headers of every game in the text (a list row each)."""
    h = io.StringIO(_text(text))
    out = []
    while len(out) < MAX_LIST:
        hd = chess.pgn.read_headers(h)
        if hd is None:
            break
        out.append(_row(len(out), hd))
    # movetext without any game in it (not a PGN at all) reads as one empty game: say so instead of opening it
    if len(out) == 1 and not any(v for k, v in out[0].items() if k != "i"):
        g = chess.pgn.read_game(io.StringIO(_text(text)))
        if g is None or (not g.variations and not g.headers.get("FEN")):
            return []
    return out


def title_of(h) -> str:
    w, b = _name(h, "White"), _name(h, "Black")
    res = RESULT.get(h.get("Result", ""), "")
    if w or b:
        return f"{w or '?'} – {b or '?'}" + (f", {res}" if res else "")
    return _name(h, "ChapterName") or _name(h, "Event") or "Партия из PGN"


def _shapes(node) -> list[dict]:
    out = []
    for a in node.arrows():
        s = {"orig": chess.square_name(a.tail), "brush": BRUSH.get(a.color, "green")}
        if a.head != a.tail:
            s["dest"] = chess.square_name(a.head)
        out.append(s)
    return out


def _comment(*parts: str) -> str:
    return "\n\n".join(t for t in (re.sub(r"[ \t]+", " ", COMMAND_RE.sub("", p or "")).strip() for p in parts) if t)


def _lead(h, game) -> str:
    """The board's top comment: who played, where and when, the opening, then the game's own comment."""
    side = lambda c: f"{_name(h, c) or '?'}" + (f" ({h.get(c + 'Elo')})" if (h.get(c + "Elo") or "").strip("?") else "")
    bits = []
    if _name(h, "White") or _name(h, "Black"):
        bits.append(f"Белые: **{side('White')}** · Чёрные: **{side('Black')}**")
    where = " · ".join(x for x in (_name(h, "Event"), (h.get("Date") or "").replace("??", "").strip("."), _name(h, "Opening")) if x)
    if where:
        bits.append(where)
    return _comment("\n\n".join(bits), game.comment)


def key_of(game) -> str:
    """The same game opened again gets the same key (its board is reused, not copied)."""
    return hashlib.sha1(str(game).encode()).hexdigest()[:16]


def read(text: str, index: int):
    h = io.StringIO(_text(text))
    for _ in range(max(0, int(index))):
        if chess.pgn.read_headers(h) is None:
            raise SceneError("в файле нет такой партии")
    game = chess.pgn.read_game(h)
    if game is None:
        raise SceneError("в файле нет такой партии")
    return game


def scene(sid: str, game) -> dict:
    h = game.headers
    try:
        board = game.board()
    except ValueError as e:
        raise SceneError(f"неверная начальная позиция в PGN: {e}") from None
    user = config.lichess_user()
    color = "black" if user and _name(h, "Black").lower() == user and _name(h, "White").lower() != user else "white"
    sc = scenes.new_scene(sid, title_of(h), board.fen(), color, comment=_lead(h, game))
    sc["root"]["shapes"] = _shapes(game)
    stack = [(game, sc["root"], board)]
    while stack:  # (iterative: a long game would be a deep recursion)
        gnode, tnode, b = stack.pop()
        for var in gnode.variations:
            mv = var.move
            if mv not in b.legal_moves:
                break
            sc["seq"] += 1
            num, san = scenes.num_label(b), b.san(mv)
            nb = b.copy(stack=False)
            nb.push(mv)
            glyph = next((NAG_GLYPH[n] for n in sorted(var.nags) if n in NAG_GLYPH), "")
            child = {"id": f"n{sc['seq']}", "uci": mv.uci(), "san": san, "fen": nb.fen(), "num": num,
                     "comment": _comment(var.starting_comment, var.comment), "shapes": _shapes(var), "glyph": glyph,
                     "label": "", "by": "game", "children": []}
            tnode["children"].append(child)
            stack.append((var, child, nb))
    if game.errors:
        sc["root"]["comment"] = _comment(sc["root"]["comment"], f"_Часть ходов не прочиталась: {game.errors[0]}_")
    sc["pgn"] = {"key": key_of(game), **_row(0, h)}
    sc["pgn"].pop("i", None)
    return sc
