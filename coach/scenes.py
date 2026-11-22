"""Study diagrams ("scenes") as Lichess-style move trees.

scene = {id, title, orientation, created, seq, root, puzzle?}
root  = {id: "root", fen, comment, shapes, children: [node]}
node  = {id, uci, san, fen, num, comment, shapes, glyph, label, by, children: [node]}

children[0] is the main continuation, the rest are variations (as on the Lichess analysis board).
`num` is the label printed before the move ("25." for White, "25…" for Black); `label` is a short
line title Claude may give ("Лучший", "В партии"); `by` is "claude" or "user" (moves the user played).
Shapes use chessground's DrawShape format: {orig, dest?, brush?, label?: {text}}.

Nodes are addressed with `at`: None/"start" (the diagram's position), "current" (resolved by the
caller), a node id ("n12"), or a move path from the start ("25.a4 Ng2", numbers optional).
"""

import re
import time

import chess

BRUSHES = {"green", "red", "blue", "yellow", "paleBlue", "paleGreen", "paleRed", "paleGrey", "purple", "pink", "white", "orange"}
COLOR_ALIASES = {
    "зелёный": "green", "зеленый": "green", "красный": "red", "синий": "blue", "жёлтый": "yellow", "желтый": "yellow",
    "grey": "paleGrey", "gray": "paleGrey",
}
GLYPHS = {"!", "?", "!!", "??", "!?", "?!"}
SQ = r"[a-h][1-8]"
SHAPE_RE = re.compile(rf"^\s*({SQ})(?:\s*[-x]?\s*({SQ}))?\s*(?::\s*([A-Za-zА-Яа-яёЁ]+))?\s*(?::\s*(.+?))?\s*$")
MOVE_NUM_RE = re.compile(r"^\d+\.(\.\.)?|^\d+…")
GLYPH_RE = re.compile(r"(!!|\?\?|!\?|\?!|!|\?)$")


class SceneError(ValueError):
    pass


# ---------------- shapes ----------------
def norm_color(c: str | None, default: str = "green") -> str:
    if not c:
        return default
    c = COLOR_ALIASES.get(c.strip(), c.strip())
    if c not in BRUSHES:
        raise SceneError(f"unknown color {c!r}; use one of: green, red, blue, yellow, orange, purple, paleGrey")
    return c


def parse_shapes(items) -> list[dict]:
    """Strings "e2e4", "e2-e4:red", "f7:yellow", "f7:red:!", "f7:none:?" or dicts {from, to?, color?, label?}."""
    if not items:
        return []
    if isinstance(items, str):
        items = [s for s in re.split(r"[,;]\s*|\s+(?=[a-h][1-8])", items) if s.strip()]
    out = []
    for it in items:
        if isinstance(it, str):
            m = SHAPE_RE.match(it)
            if not m:
                raise SceneError(f"bad shape {it!r}; examples: 'e2e4', 'e2e4:red', 'f7:yellow', 'f7:red:!'")
            orig, dest, color, label = m.groups()
        elif isinstance(it, dict):
            orig = it.get("from") or it.get("orig") or it.get("square")
            dest = it.get("to") or it.get("dest")
            color = it.get("color") or it.get("brush")
            label = it.get("label")
            if not orig or not re.fullmatch(SQ, orig) or (dest and not re.fullmatch(SQ, dest)):
                raise SceneError(f"bad shape {it!r}")
        else:
            raise SceneError(f"bad shape {it!r}")
        shape: dict = {"orig": orig}
        if dest and dest != orig:
            shape["dest"] = dest
        if color != "none":
            shape["brush"] = norm_color(color)
        if label:
            shape["label"] = {"text": str(label)[:3]}
        out.append(shape)
    return out


# ---------------- moves and positions ----------------
def num_label(board: chess.Board) -> str:
    return f"{board.fullmove_number}." if board.turn == chess.WHITE else f"{board.fullmove_number}…"


def parse_move(board: chess.Board, text: str) -> chess.Move:
    t = GLYPH_RE.sub("", text.strip()).replace("0-0-0", "O-O-O").replace("0-0", "O-O")
    try:
        return board.parse_san(t)
    except ValueError:
        pass
    try:
        mv = chess.Move.from_uci(t.lower())
        if mv in board.legal_moves:
            return mv
    except ValueError:
        pass
    raise SceneError(f"move {text!r} is not legal in {board.fen()} ({'White' if board.turn else 'Black'} to move)")


def split_moves(text: str) -> list[str]:
    toks = []
    for tok in text.replace("\n", " ").split():
        tok = MOVE_NUM_RE.sub("", tok).strip()
        if tok and tok not in ("*", "1-0", "0-1", "1/2-1/2", "…", "..."):
            toks.append(tok)
    return toks


def parse_position(spec: str | None, current_fen: str | None = None) -> chess.Board:
    """'start' | 'current' | FEN | moves from the initial position ("1.e4 e5 2.Nf3")."""
    s = (spec or "start").strip()
    if s in ("start", "startpos", "initial"):
        return chess.Board()
    if s == "current":
        if not current_fen:
            raise SceneError("the board has no current position yet")
        return chess.Board(current_fen)
    if "/" in s:
        try:
            return chess.Board(s)
        except ValueError as e:
            raise SceneError(f"bad FEN: {e}") from e
    b = chess.Board()
    for tok in split_moves(s):
        b.push(parse_move(b, tok))
    return b


# ---------------- tree ----------------
def new_scene(sid: str, title: str, fen: str, orientation: str, comment: str = "", shapes=None) -> dict:
    return {
        "id": sid,
        "title": title or "Позиция",
        "orientation": orientation,
        "created": int(time.time() * 1000),
        "seq": 0,
        "root": {"id": "root", "fen": fen, "comment": comment, "shapes": parse_shapes(shapes), "children": []},
    }


def walk(node: dict, parent: dict | None = None):
    yield node, parent
    for c in node["children"]:
        yield from walk(c, node)


def index(scene: dict) -> dict[str, tuple[dict, dict | None]]:
    return {n["id"]: (n, p) for n, p in walk(scene["root"])}


def path_of(scene: dict, node_id: str) -> list[dict]:
    """Nodes from the first move to `node_id` (empty for the root)."""
    idx = index(scene)
    if node_id not in idx:
        raise SceneError(f"no node {node_id!r} in this diagram")
    out = []
    n, p = idx[node_id]
    while p is not None:
        out.append(n)
        n, p = idx[p["id"]]
    return out[::-1]


def path_text(nodes: list[dict]) -> str:
    out = []
    for i, n in enumerate(nodes):
        out.append(n["num"] + n["san"] if n["num"].endswith(".") or i == 0 else n["san"])
    return " ".join(out)


def fen_key(fen: str) -> str:
    return " ".join(fen.split(" ")[:4])


def find(scene: dict, at, create: bool = False) -> dict:
    """Resolve `at` (None/'start'/node id/move path) to a node. A move path that is not in the tree
    still finds a node with the same position (another move order); with `create` it is added."""
    if at is None or at in ("", "start", "root"):
        return scene["root"]
    if isinstance(at, str) and re.fullmatch(r"n\d+", at):
        idx = index(scene)
        if at not in idx:
            raise SceneError(f"no node {at!r} in this diagram")
        return idx[at][0]
    toks = split_moves(at) if isinstance(at, str) else list(at)
    node = scene["root"]
    for i, tok in enumerate(toks):
        board = chess.Board(node["fen"])
        mv = parse_move(board, tok)
        nxt = next((c for c in node["children"] if c["uci"] == mv.uci()), None)
        if nxt is None:
            # the same position may be in the tree through another move order
            target = chess.Board(node["fen"])
            for t in toks[i:]:
                target.push(parse_move(target, t))
            key = fen_key(target.fen())
            for n, _ in walk(scene["root"]):
                if fen_key(n["fen"]) == key:
                    return n
            if create:
                return add_moves(scene, node, toks[i:])[-1]
            have = path_text(path_of(scene, node["id"])) or "the start"
            raise SceneError(f"the diagram has no move {tok!r} after {have} and no node with that position")
        node = nxt
    return node


def _item(it) -> tuple[str, dict]:
    """A move item: 'Nf3', '2.Nf3', '3...Nf6' or {move, comment, shapes, glyph}; move numbers are dropped."""
    if isinstance(it, dict):
        text = it.get("move") or it.get("san") or it.get("uci")
        if not text:
            raise SceneError(f"move item {it!r} has no 'move' field")
    else:
        text, it = it, {}
    return MOVE_NUM_RE.sub("", str(text).strip()).strip(), it


def add_moves(scene: dict, parent: dict, moves, *, by: str = "claude", title: str = "", comment: str = "", shapes=None) -> list[dict]:
    """Play `moves` from `parent`, reusing existing branches and creating new ones. Returns the nodes."""
    items = split_moves(moves) if isinstance(moves, str) else list(moves or [])
    nodes = []
    node = parent
    for i, it in enumerate(items):
        text, extra = _item(it)
        board = chess.Board(node["fen"])
        try:
            mv = parse_move(board, text)
        except SceneError as e:
            done = path_text(nodes)
            raise SceneError(f"{e} — after: {done or '(line start)'}") from None
        child = next((c for c in node["children"] if c["uci"] == mv.uci()), None)
        if child is None:
            scene["seq"] += 1
            num, san = num_label(board), board.san(mv)
            board.push(mv)
            child = {"id": f"n{scene['seq']}", "uci": mv.uci(), "san": san, "fen": board.fen(), "num": num,
                     "comment": "", "shapes": [], "glyph": "", "label": "", "by": by, "children": []}
            node["children"].append(child)
        g = GLYPH_RE.search(text.strip())
        if g and by == "claude":
            child["glyph"] = g.group(1)
        if extra.get("glyph"):
            set_glyph(child, extra["glyph"])
        if extra.get("comment"):
            child["comment"] = extra["comment"]
        if extra.get("shapes"):
            child["shapes"] = parse_shapes(extra["shapes"])
        nodes.append(child)
        node = child
    if nodes:
        if title and not nodes[0]["label"]:
            nodes[0]["label"] = title
        if comment:
            nodes[0]["comment"] = (comment + "\n\n" + nodes[0]["comment"]).strip() if nodes[0]["comment"] and nodes[0]["comment"] != comment else comment
        if shapes:
            nodes[0]["shapes"] = parse_shapes(shapes)
    return nodes


def set_glyph(node: dict, glyph: str) -> None:
    if glyph and glyph not in GLYPHS:
        raise SceneError(f"glyph must be one of {sorted(GLYPHS)}")
    node["glyph"] = glyph or ""


def promote(scene: dict, node_id: str) -> None:
    """Make the line through `node_id` the main line (Lichess: 'make main line')."""
    idx = index(scene)
    if node_id not in idx:
        raise SceneError(f"no node {node_id!r}")
    n, p = idx[node_id]
    while p is not None:
        p["children"].remove(n)
        p["children"].insert(0, n)
        n, p = idx[p["id"]]


def delete(scene: dict, node_id: str) -> dict:
    """Delete a node and everything after it; returns its parent."""
    idx = index(scene)
    if node_id not in idx or node_id == "root":
        raise SceneError(f"cannot delete {node_id!r}")
    n, p = idx[node_id]
    assert p is not None
    p["children"].remove(n)
    return p


def make_scene(sid: str, spec: dict, current_fen: str | None = None) -> tuple[dict, dict | None]:
    """Build a scene from Claude's spec; returns (scene, first node of the first line or None)."""
    board = parse_position(spec.get("position"), current_fen)
    orientation = spec.get("orientation") or ("white" if board.turn == chess.WHITE else "black")
    if orientation not in ("white", "black"):
        raise SceneError("orientation must be 'white' or 'black'")
    sc = new_scene(sid, spec.get("title") or "Позиция", board.fen(), orientation, spec.get("comment") or "", spec.get("shapes"))
    if board.move_stack:  # a position given as moves keeps them: the moves before the board stay clickable in text
        sc["history"] = {"start": board.root().fen(), "moves": [m.uci() for m in board.move_stack]}
    first = None
    for i, raw in enumerate(spec.get("lines") or []):
        ln: dict = {"moves": raw} if isinstance(raw, (str, list)) else raw
        try:
            start = find(sc, ln.get("at") or ln.get("from"), create=True)
            nodes = add_moves(sc, start, ln.get("moves") or [], title=ln.get("title") or "", comment=ln.get("comment") or "", shapes=ln.get("shapes"))
        except SceneError as e:
            raise SceneError(f"line {i} ({ln.get('title') or 'untitled'}): {e}") from None
        if first is None and nodes:
            first = nodes[0]
    return sc, first


def from_old(old: dict) -> dict:
    """Convert a scene saved by the first version (list of lines) into a tree."""
    sc = new_scene(old["id"], old.get("title", ""), old["fen"], old.get("orientation", "white"), old.get("comment", ""))
    sc["root"]["shapes"] = old.get("shapes", [])
    sc["created"] = old.get("created", sc["created"])
    for ln in old.get("lines", []):
        start = sc["root"] if ln.get("fen") == old["fen"] else None
        if start is None:
            continue
        nodes = add_moves(sc, start, [n["uci"] for n in ln["nodes"]], title=ln.get("title", ""), comment=ln.get("comment", ""))
        for n, o in zip(nodes, ln["nodes"]):
            n["comment"] = o.get("comment", "") or n["comment"]
            n["shapes"] = o.get("shapes", [])
    if old.get("puzzle"):
        sc["puzzle"] = old["puzzle"]
    return sc


# ---------------- text for Claude ----------------
def _num(n: dict, force: bool) -> str:
    if n["num"].endswith("."):
        return n["num"]
    return n["num"].replace("…", "...") if force else ""


def pgn(scene: dict, with_ids: bool = False) -> str:
    """Movetext with variations in parentheses and {comments}; optional [nX] ids after moves."""

    def mv(n: dict, force: bool) -> str:
        s = _num(n, force) + n["san"] + (n["glyph"] or "")
        if with_ids:
            s += f"[{n['id']}{'·user' if n.get('by') == 'user' else ''}]"
        if n["label"]:
            s = f"<{n['label']}> " + s
        if n["comment"]:
            s += " {" + n["comment"].replace("}", ")") + "}"
        return s

    def line_from(parent: dict, force: bool) -> list[str]:
        out = []
        node = parent
        while node["children"]:
            main, alts = node["children"][0], node["children"][1:]
            out.append(mv(main, force))
            force = bool(main["comment"])
            for a in alts:
                out.append("(" + " ".join([mv(a, True)] + line_from(a, bool(a["comment"]))) + ")")
                force = True
            node = main
        return out

    return " ".join(line_from(scene["root"], True))


def user_branches(scene: dict) -> list[str]:
    """Paths (from the start) that end in moves the user played themselves."""
    out = []
    for n, _ in walk(scene["root"]):
        if n.get("by") == "user" and not n["children"]:
            out.append(path_text(path_of(scene, n["id"])))
    return out
