"""The opening repertoire — the «Репертуар» mode: what the user plays, as two move trees, «За белых» and
«За чёрных», with named sections (openings), lessons and Claude's notes.

- A tree is a board in the scene format of coach/scenes.py, kept in app/repertoire.json, not in scenes.json:
  board.py finds and saves it through board.EXTERNAL, so the window's tree view and its edits (moves, promote,
  delete) work on it as on any board. Its moves are the ones the user decided to play ("by": "user" or
  "claude"); "by": "games" marks the way to a section taken from the user's games.
- A section is a node of a tree with a name («Итальянская партия» after 1.e4 e5 2.Nf3 Nc6 3.Bc4). The first
  sections come from the user's games (first moves and openings met at least MIN_GAMES times); the user or
  Claude adds more. A section the user no longer plays is retired: kept with its lessons, out of training.
- A lesson is a chat bound to a section. Every chat is a separate Claude session, so Claude keeps notes per
  section (and general ones): its memory between lessons, not shown in the window. They are brought up to date
  when a lesson's tab is closed or the lesson has been quiet for IDLE seconds; a lesson whose update was cut off
  (the app quit) is caught up by the next lesson of that section, which reads its transcript.
- The drill (app.js REPERTOIRE): the app plays the opponent's moves of a tree and the user plays their own from
  memory. A card is a position where it is the user's move, keyed by colour and position (another move order
  reaches the same card); its answer is the main move there (the first of the user's moves). Cards are spaced
  like the puzzles: a right answer moves the card a step further (DRILL_STEPS), a wrong one brings it back soon.
- The user's games against the trees: a game follows its tree move by move (another move order reaching a position
  of the tree counts too) until someone leaves it — the user (a mistake to look at), the opponent (a reply the
  repertoire still lacks) — or the tree runs out (the end of the preparation). The user leaving it counts as a
  mistake only when the move they skipped was written into the tree before the game (every node keeps "at", the
  time it was written; 0 = before this was kept); earlier games, and moves the tree only took from the games, are
  habits («раньше играл иначе»), shown apart. A section lists its games so, and
  a finished live game says it under the result (the window asks after the game, never during it).
- A training game against the engine (app.js REPERTOIRE): the window plays the opponent's moves of the tree (or of
  the line Claude chose with repertoire_play), then asks /api/rep/engine for Stockfish's move at a limited strength
  (UCI_Elo) — a Stockfish process of its own, so the analysis engine keeps full strength.
- While a live Lichess game is on (S.lock) the repertoire is closed: it is opening preparation.
"""

import asyncio
import contextlib
import json
import re
import threading
import time
from collections import Counter

import anyio
import chess
import chess.engine
from claude_agent_sdk import tool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import board, openings, review, scenes
from .board import DATA, S, broadcast, load_json, save_json
from .engine import STOCKFISH
from .scenes import SceneError

FILE = DATA / "repertoire.json"
CHATS_DIR = DATA / "chats"
COLORS = ("white", "black")
TREE = {"white": "rep-white", "black": "rep-black"}
TITLE = {"white": "За белых", "black": "За чёрных"}
MIN_GAMES = 3
PLIES = 40  # how far a game is followed for sections, their statistics and the check against the trees
IDLE = 15 * 60
DRILL_STEPS = [10 * 60, 86400, 3 * 86400, 7 * 86400, 16 * 86400, 35 * 86400, 80 * 86400]  # seconds until a card is due again
# families too wide to be one opening: their variation is the section («Queen's Pawn Game: Chigorin Variation»)
GENERIC = {"King's Pawn Game", "Queen's Pawn Game", "Indian Defense", "King's Knight Opening", "King's Pawn Opening", "Zukertort Opening"}


def theme(name: str | None) -> str | None:
    """Which section a Lichess opening name belongs to: its family, or family + variation for a generic family."""
    if not name:
        return None
    if "London System" in name:
        return "London System"
    fam = openings.family(name)
    if fam in GENERIC:
        return f"{fam}: {name.split(':', 1)[1].split(',')[0].strip()}" if ":" in name else None
    return fam


# ---------------- the user's games, followed through the opening ----------------
_games: dict = {"src": None, "list": []}


def games() -> list[dict]:
    """The user's standard games: {id, color, result (1 / 0.5 / 0), ucis and position keys of the first PLIES plies,
    theme, date, opp, url}, newest first."""
    src = review.stored_games()
    if _games["src"] is src:
        return _games["list"]
    out = []
    for g in src:
        if g.get("variant") not in (None, "standard") or g.get("initialFen"):
            continue
        s = review._summary(g)
        b, ucis, keys = chess.Board(), [], []
        for san in (g.get("moves") or "").split()[:PLIES]:
            try:
                m = b.parse_san(san)
            except ValueError:
                break
            b.push(m)
            ucis.append(m.uci())
            keys.append(openings.key(b))
        out.append({"id": g["id"], "color": s["color"], "result": {"win": 1.0, "draw": 0.5}.get(s["result"], 0.0),
                    "ucis": ucis, "keys": set(keys), "theme": theme((g.get("opening") or {}).get("name")),
                    "date": s["date"], "opp": s["opp"], "oppRating": s["oppRating"], "outcome": s["result"],
                    "url": f"https://lichess.org/{g['id']}/{s['color']}"})
    _games.update(src=src, list=out)
    return out


def san_path(nodes: list[dict]) -> str:
    return scenes.path_text(nodes)


# ---------------- the store ----------------
class Repertoire:
    def __init__(self) -> None:
        self.d = load_json(FILE, None) or {}
        self.d.setdefault("trees", {})
        for c in COLORS:
            if c not in self.d["trees"]:
                sc = scenes.new_scene(TREE[c], TITLE[c], chess.STARTING_FEN, c)
                sc["rep"] = c
                self.d["trees"][c] = sc
        for key, default in (("sections", []), ("notes", {}), ("lessons", {}), ("seq", 0), ("seeded", False), ("drill", {})):
            self.d.setdefault(key, default)
        for tree in self.d["trees"].values():  # moves written before the time was kept: unknown, so never "already learned"
            for n, _ in scenes.walk(tree["root"]):
                n.setdefault("at", 0)
        self.task: asyncio.Task | None = None

    # ---- basics ----
    @property
    def trees(self) -> dict:
        return self.d["trees"]

    def save(self, _sc: dict | None = None) -> None:
        now = int(time.time() * 1000)
        for tree in self.d["trees"].values():  # the moves written since the last save get their time
            for n, _ in scenes.walk(tree["root"]):
                n.setdefault("at", now)
        save_json(FILE, self.d)

    def tree_by_id(self, sid: str | None) -> dict | None:
        return next((t for t in self.trees.values() if t["id"] == sid), None) if sid else None

    def section(self, sid: str | None) -> dict:
        sec = next((s for s in self.d["sections"] if s["id"] == sid), None)
        if sec is None:
            raise SceneError(f"no section {sid!r}; sections: " + ", ".join(f"{s['id']} «{s['name']}»" for s in self.d["sections"]))
        return sec

    def node(self, sec: dict) -> dict:
        return scenes.find(self.trees[sec["color"]], sec["node"])

    def lesson_section(self, chat_id: str | None) -> dict | None:
        les = self.d["lessons"].get(chat_id or "")
        return next((s for s in self.d["sections"] if s["id"] == les["section"]), None) if les else None

    async def emit(self) -> None:
        await broadcast({"type": "rep", "rep": self.public(trees=False)})

    # ---- sections ----
    def add_section(self, color: str, moves, name: str, *, theme_: str | None = None, by: str = "user") -> dict:
        tree = self.trees[color]
        if isinstance(moves, str) and re.fullmatch(r"n\d+", moves):  # a node of the tree
            node = scenes.find(tree, moves)
        else:  # moves from the initial position
            node = (scenes.add_moves(tree, tree["root"], moves, by=by) or [tree["root"]])[-1]
        if node is tree["root"]:
            raise SceneError("a section needs at least one move from the initial position")
        old = next((s for s in self.d["sections"] if s["color"] == color and s["node"] == node["id"]), None)
        if old:
            return old
        self.d["seq"] += 1
        sec = {"id": f"r{self.d['seq']}", "color": color, "node": node["id"], "name": name.strip() or self.auto_name(tree, node),
               "theme": theme_, "status": "active", "by": by, "created": time.time()}
        self.d["sections"].append(sec)
        return sec

    def auto_name(self, tree: dict, node: dict) -> str:
        path = scenes.path_of(tree, node["id"])
        name = openings.name_along([n["uci"] for n in path])
        return openings.ru(name) if name else f"После {san_path(path)}"

    def seed(self) -> int:
        """Sections from the user's games: the first moves (White's own, Black's opponent's), then every opening
        met at least MIN_GAMES times, at the move where it usually begins. Never removes anything."""
        gl = games()
        before = len(self.d["sections"])
        for color in COLORS:
            mine = [g for g in gl if g["color"] == color and g["ucis"]]
            for u, n in Counter(g["ucis"][0] for g in mine).most_common():
                if n >= MIN_GAMES:
                    san = chess.Board().san(chess.Move.from_uci(u))
                    self.add_section(color, [u], f"Против 1.{san}" if color == "black" else f"1.{san}", by="games")
            for th, n in Counter(g["theme"] for g in mine if g["theme"]).most_common():
                if n < MIN_GAMES:
                    continue
                starts: Counter = Counter()
                for g in mine:
                    if g["theme"] != th:
                        continue
                    b = chess.Board()
                    for i, u in enumerate(g["ucis"]):
                        b.push(chess.Move.from_uci(u))
                        hit = openings.name_at(b)
                        if hit and theme(hit[1]) == th:
                            starts[tuple(g["ucis"][: i + 1])] += 1
                            break
                if starts:
                    self.add_section(color, list(starts.most_common(1)[0][0]), openings.ru(th), theme_=th, by="games")
        self.d["seeded"] = True
        self.save()
        return len(self.d["sections"]) - before

    def ensure_seeded(self) -> None:
        if not self.d["seeded"] and review.stored_games():
            with contextlib.suppress(Exception):
                self.seed()

    def guard_delete(self, tree: dict, node_id: str) -> None:
        """A move under which a section starts cannot be deleted from the tree (the section would lose its place)."""
        sub = {n["id"] for n, _ in scenes.walk(scenes.find(tree, node_id))}
        hit = [s["name"] for s in self.d["sections"] if s["color"] == tree["rep"] and s["node"] in sub]
        if hit:
            raise SceneError("здесь начинается раздел «" + "», «".join(hit) + "»: сначала удали раздел")

    # ---- statistics ----
    def section_games(self, sec: dict) -> list[dict]:
        k = openings.key(chess.Board(self.node(sec)["fen"]))
        th = sec.get("theme")
        return [g for g in games() if g["color"] == sec["color"] and (k in g["keys"] or (th and g["theme"] == th))]

    def stats(self, sec: dict, recent: int = 8) -> dict:
        gl = self.section_games(sec)
        return {"games": len(gl), "score": round(100 * sum(g["result"] for g in gl) / len(gl)) if gl else None,
                "recent": [{k: g[k] for k in ("id", "date", "outcome", "opp", "oppRating", "url")} for g in gl[:recent]]}

    # ---- what the window gets ----
    def public(self, trees: bool = True) -> dict:
        from .chat import CHATS
        if trees:  # the window's first load: sections from the games, if there are none yet
            self.ensure_seeded()
        order: dict[tuple, int] = {}
        for c in COLORS:
            for i, (n, _) in enumerate(scenes.walk(self.trees[c]["root"])):
                order[(c, n["id"])] = i
        secs = []
        for s in self.d["sections"]:
            try:
                tree = self.trees[s["color"]]
                path = scenes.path_of(tree, s["node"])
            except SceneError:
                continue
            ids = {n["id"] for n in path[:-1]}
            parent = max((p for p in self.d["sections"] if p["color"] == s["color"] and p["node"] in ids),
                         key=lambda p: order.get((p["color"], p["node"]), -1), default=None)
            secs.append({**s, "path": san_path(path), "parent": parent["id"] if parent else None, **self.stats(s),
                         "notes_at": (self.d["notes"].get(s["id"]) or {}).get("at"),
                         "lessons": [cid for cid, les in self.d["lessons"].items() if les["section"] == s["id"] and cid in CHATS.chats]})
        secs.sort(key=lambda s: (COLORS.index(s["color"]), order.get((s["color"], s["node"]), 0)))
        out = {"sections": secs, "lessons": {cid: {"section": les["section"]} for cid, les in self.d["lessons"].items() if cid in CHATS.chats},
               "drill": self.d["drill"]}
        if trees:
            out["trees"] = [self.trees[c] for c in COLORS]
        return out

    # ---- the user's games against the trees ----
    def positions(self, color: str) -> dict[str, dict]:
        """Position key → node of a tree (main lines first): another move order reaches the same node."""
        out: dict[str, dict] = {}
        for n, _ in scenes.walk(self.trees[color]["root"]):
            out.setdefault(" ".join(n["fen"].split()[:4]), n)
        return out

    def section_at(self, color: str, node_id: str) -> dict | None:
        """The deepest section on the way to a node (the node itself included)."""
        way = {n["id"]: i for i, n in enumerate(scenes.path_of(self.trees[color], node_id))}
        on = [s for s in self.d["sections"] if s["color"] == color and s["node"] in way]
        return max(on, key=lambda s: way[s["node"]], default=None)

    def check_game(self, color: str, ucis: list[str], pos: dict | None = None, date: int | None = None) -> dict:
        """How far a game from the initial position went along the tree of the user's colour: kind "user" / "opponent"
        (who left it, with the move played and the tree's moves there), "end" (the tree had no more moves), "in" (it
        never left). `node` is the last node of the tree the game reached."""
        tree = self.trees[color]
        pos = pos if pos is not None else self.positions(color)
        node, b = tree["root"], chess.Board()
        out: dict = {"kind": "in"}
        skip = 0
        for i, u in enumerate(ucis):
            try:
                mv = chess.Move.from_uci(u)
            except ValueError:
                break
            if mv not in b.legal_moves:
                break
            num, san, mover = scenes.num_label(b), b.san(mv), "white" if b.turn == chess.WHITE else "black"
            child = next((c for c in node["children"] if c["uci"] == u), None)
            b.push(mv)
            if skip:  # moves of another order that come back into the tree: the last one lands on a node
                skip -= 1
                if not skip:
                    node = pos[openings.key(b)]
                continue
            child = child or pos.get(openings.key(b))
            if child is None:
                skip = _back_in(b, ucis[i + 1: i + 5], pos)
                if skip:
                    continue
                out = {"kind": "end" if not node["children"] else "user" if mover == color else "opponent",
                       "ply": i + 1, "num": num, "played": san, "uci": u, "expected": [c["san"] for c in node["children"]]}
                if out["kind"] == "user":  # a mistake only if the main move was written before the game (`date`, ms)
                    main = node["children"][0]
                    out["learned"] = bool(main.get("by") != "games" and main.get("at") and (date or 0) > main["at"])
                break
            node = child
        sec = self.section_at(color, node["id"])
        return {**out, "node": node["id"], "before": san_path(scenes.path_of(tree, node["id"])),
                "section": sec["id"] if sec else None, "section_name": sec["name"] if sec else None}

    def games_report(self, sec: dict, recent: int = 12) -> dict:
        """A section's games against its tree: where the user and the opponents left it, where the preparation ended."""
        color = sec["color"]
        pos = self.positions(color)
        rows, groups = [], {"user": {}, "habit": {}, "opponent": {}, "end": {}}
        for g in self.section_games(sec):
            chk = self.check_game(color, g["ucis"], pos, g["date"])
            rows.append({**{k: g[k] for k in ("id", "date", "outcome", "opp", "oppRating", "url")}, "ucis": g["ucis"], "check": chk})
            kind = "habit" if chk["kind"] == "user" and not chk.get("learned") else chk["kind"]
            if kind in groups:
                key = (chk["node"], "" if kind == "end" else chk["uci"])
                grp = groups[kind].setdefault(key, {k: chk.get(k) for k in ("node", "before", "num", "played", "uci", "expected")} | {"games": 0})
                grp["games"] += 1
        top = {k: sorted(v.values(), key=lambda x: -x["games"])[:6] for k, v in groups.items()}
        counts = Counter("habit" if r["check"]["kind"] == "user" and not r["check"].get("learned") else r["check"]["kind"] for r in rows)
        return {"section": sec["id"], "games": len(rows), "counts": dict(counts), **top, "recent": rows[:recent]}

    # ---- the drill ----
    def drill_answer(self, key: str, ok: bool) -> dict:
        color, _, pos = key.partition(":")
        if color not in COLORS or len(pos.split()) != 4:
            raise SceneError(f"bad card {key!r}")
        c = self.d["drill"].get(key) or {"box": 0, "ok": 0, "fail": 0}
        box = min(c["box"] + 1, len(DRILL_STEPS) - 1) if ok else 0
        now = time.time()
        c.update(box=box, due=int((now + DRILL_STEPS[box]) * 1000), last=int(now * 1000), ok=c["ok"] + int(ok), fail=c["fail"] + int(not ok))
        self.d["drill"][key] = c
        self.save()
        return c

    def drill_cards(self, sec: dict) -> list[tuple[str, str]]:
        """(card key, «path → answer») of a section: the user's moves on the way to it and in its tree (main moves)."""
        tree = self.trees[sec["color"]]
        mine = chess.WHITE if sec["color"] == "white" else chess.BLACK
        path = scenes.path_of(tree, sec["node"])
        out = []

        def card(node: dict, answer: dict) -> None:
            if chess.Board(node["fen"]).turn == mine:
                before = san_path(scenes.path_of(tree, node["id"])) or "(начало)"
                out.append((f"{sec['color']}:{' '.join(node['fen'].split()[:4])}", f"{before} → {answer['san']}"))

        for parent, child in zip([tree["root"], *path[:-1]], path):
            card(parent, child)

        def below(node: dict) -> None:
            if not node["children"]:
                return
            if chess.Board(node["fen"]).turn == mine:
                card(node, node["children"][0])
                below(node["children"][0])
            else:
                for c in node["children"]:
                    below(c)

        below(self.node(sec))
        return out

    def drill_summary(self, sec: dict) -> dict:
        now = time.time() * 1000
        cards = self.drill_cards(sec)
        prog = [(text, self.d["drill"].get(key)) for key, text in cards]
        missed = sorted((p for p in prog if p[1] and p[1]["fail"]), key=lambda p: (-p[1]["fail"], p[1]["ok"]))
        return {"cards": len(cards), "never_trained": sum(1 for _, c in prog if c is None),
                "due_now": sum(1 for _, c in prog if c is None or c["due"] <= now),
                "often_missed": [f"{t}: ошибок {c['fail']}, верно {c['ok']}" for t, c in missed[:8]]}

    # ---- notes ----
    def notes(self, key: str) -> str:
        return (self.d["notes"].get(key) or {}).get("text", "")

    def write_notes(self, chat_id: str | None, key: str, text: str, append: bool = False) -> dict:
        if key != "general":
            self.section(key)
        old = self.notes(key)
        text = (old + "\n\n" + text).strip() if append and old else text.strip()
        self.d["notes"][key] = {"text": text, "at": time.time()}
        les = self.d["lessons"].get(chat_id or "")
        if les:
            les["notes_at"] = time.time()
            for cid in les.pop("catchup", []):  # earlier lessons this one read and folded in
                if cid in self.d["lessons"]:
                    self.d["lessons"][cid]["notes_at"] = time.time()
        self.save()
        return {"ok": True, "notes": key, "lines": text.count("\n") + 1 if text else 0}

    def notes_due(self, chat) -> bool:
        """A lesson with something said by the user after its last notes update (or request for one)."""
        les = self.d["lessons"].get(chat.id)
        if not les:
            return False
        since = max(les.get("notes_at", 0), les.get("asked", 0))
        return any(e.get("kind") == "user" and e.get("ts", 0) > since for e in chat.entries)

    async def ask_notes(self, chat) -> None:
        """Ask the lesson's Claude to bring the notes up to date (a hidden request; the chat shows a short note)."""
        from .chat import CHATS
        les = self.d["lessons"][chat.id]
        les["asked"] = time.time()
        self.save()
        sec = self.lesson_section(chat.id)
        await CHATS.send(chat.id, NOTES_ASK.replace("<<SECTION>>", f"«{sec['name']}» ({sec['id']})" if sec else "урока"),
                         note="Claude дописывает конспект урока")

    async def tick(self) -> None:
        """A lesson quiet for IDLE seconds with something new in it gets its notes updated."""
        from .chat import CHATS
        if S.lock:
            return
        now = time.time()
        for cid in list(self.d["lessons"]):
            chat = CHATS.chats.get(cid)
            if chat is None or chat.busy or not chat.entries or now - chat.entries[-1].get("ts", now) < IDLE:
                continue
            if self.notes_due(chat):
                with contextlib.suppress(Exception):
                    await self.ask_notes(chat)

    async def watch(self) -> None:
        while True:
            await asyncio.sleep(60)
            await self.tick()

    def start(self) -> None:
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.watch())

    # ---- lessons ----
    async def new_lesson(self, sid: str, model: str | None = None, effort: str | None = None):
        from .chat import CHATS
        self.section(sid)
        chat = await CHATS.create(model, effort)
        self.d["lessons"][chat.id] = {"section": sid, "created": time.time(), "notes_at": time.time()}
        self.save()
        await self.emit()
        return chat

    def prompt(self, chat_id: str) -> str:
        """The repertoire part of a chat's system prompt; for a lesson also its section, the notes and lessons to catch up."""
        sec = self.lesson_section(chat_id)
        if sec is None:
            return REP_PROMPT
        from .chat import CHATS
        path = san_path(scenes.path_of(self.trees[sec["color"]], sec["node"]))
        behind = [cid for cid, les in self.d["lessons"].items() if les["section"] == sec["id"] and cid != chat_id
                  and cid in CHATS.chats and self.notes_due(CHATS.chats[cid])]
        self.d["lessons"][chat_id]["catchup"] = behind
        self.save()
        out = REP_PROMPT + LESSON_PROMPT.replace("<<NAME>>", sec["name"]).replace("<<ID>>", sec["id"]).replace(
            "<<SIDE>>", TITLE[sec["color"]].lower()).replace("<<PATH>>", path)
        out += "\n### Notes so far (general)\n" + (self.notes("general") or "(empty)")
        out += f"\n### Notes so far (section {sec['id']})\n" + (self.notes(sec["id"]) or "(empty: this is the first lesson)")
        if behind:
            out += ("\n### Lessons not in the notes yet\nTheir notes update was cut off. Before your first answer read their "
                    "transcripts (JSON, entries of kind user/assistant) and fold them into the notes with repertoire_notes:\n")
            out += "\n".join(f"- «{CHATS.chats[c].title}»: {CHATS_DIR / (c + '.json')}" for c in behind)
        return out + "\n"

    # ---- edits shared by the UI and Claude ----
    def pick(self, chat_id: str | None, args: dict) -> tuple[dict | None, str]:
        sec = self.section(args["section"]) if args.get("section") else self.lesson_section(chat_id)
        color = args.get("color") or (sec["color"] if sec else None)
        if color not in COLORS:
            raise SceneError("say which tree: color 'white' or 'black' (or a section)")
        return sec, color

    def at_node(self, tree: dict, at, sec: dict | None) -> dict:
        if at in (None, "", "section"):
            return self.node(sec) if sec and sec["color"] == tree["rep"] else tree["root"]
        return scenes.find(tree, at, create=True)

    async def show_tree(self, tree: dict, node_id: str, chat_id: str | None) -> None:
        await broadcast({"type": "scene", "scene": tree, "goto": node_id, "by_chat": chat_id})


REP = Repertoire()


class PlayEngine:
    """Stockfish as the opponent of training games: its own process, its strength limited to about `elo`."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._e: chess.engine.SimpleEngine | None = None

    def move(self, fen: str, elo: int) -> chess.Move:
        board = chess.Board(fen)
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._e is None:
                        self._e = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
                    opt = self._e.options.get("UCI_Elo")
                    if opt and elo < (opt.max or 3190):
                        self._e.configure({"UCI_LimitStrength": True, "UCI_Elo": max(opt.min or 1320, elo)})
                    else:
                        self._e.configure({"UCI_LimitStrength": False})
                    return self._e.play(board, chess.engine.Limit(time=0.4)).move
                except chess.engine.EngineTerminatedError:
                    self._e = None  # Stockfish died: start it again once
                    if attempt == 2:
                        raise
        raise SceneError("no engine")

    def close(self) -> None:
        with self._lock:
            if self._e is not None:
                with contextlib.suppress(Exception):
                    self._e.quit()
                self._e = None


PLAY = PlayEngine()
board.EXTERNAL.update(find=REP.tree_by_id, save=REP.save, guard_delete=REP.guard_delete)


# ---------------- Claude ----------------
REP_PROMPT = """
## The user's opening repertoire
The «Репертуар» mode keeps what the user plays: two move trees, «За белых» and «За чёрных», with named sections
(openings: «Итальянская партия», «Против 1.d4», …). Moves in them are moves the user decided to play; the moves
leading to a section may come from the user's games. Lessons are chats bound to one section.
- `repertoire_state` shows the sections with the user's results in them, a section's tree and your notes.
- `repertoire_add` writes moves into a tree. Write only moves the user agreed to play («да, так и буду играть»),
  never a line you merely show: show those on a board of this chat (`show`, `add_line`). On the user's side keep
  one move per position (a second one is an alternative); on the opponent's side add every reply worth preparing.
- `repertoire_edit` (promote, delete, comment, goto), `repertoire_section` (create, rename, retire, restore): only
  when the user asks. A section the user stopped playing is retired, never deleted.
- `repertoire_state` also compares the user's games with a section's tree: where the user left it after the move
  was written into the tree (worth a lesson: they forgot it), where they played otherwise before it was written (an
  old habit, not forgetting), which opponent replies the tree lacks, where the preparation ends.
- `repertoire_play` starts a training game against the engine on the user's board, steered into the line you give
  (e.g. one the user keeps missing in games or in the drill); offer it when the user wants to play a line out.
- The user drills the repertoire from memory in the app (the app plays the opponent's moves, the user their own);
  `repertoire_state` shows a section's drill results — positions they often miss are worth a lesson.
- `repertoire_notes` is your memory between lessons (each chat is a separate session). The user does not see the
  notes unless they ask; when they ask, show them in the chat and fix what they correct.
"""

LESSON_PROMPT = """
## This chat is a lesson of section «<<NAME>>» (<<ID>>, <<SIDE>>, <<PATH>>)
Start from `repertoire_state`: the section's tree, the user's games and results in it, your notes. Teach it step by
step: ideas and plans first, then concrete moves; check every line with `analyse`. Ask before writing a move into
the repertoire. Keep the notes short and in order (план, пройдено, выбранные ходы, ошибки, дальше) — rewrite
them whole with repertoire_notes, do not pile up repeats; things about the player in general go to "general".
"""

NOTES_ASK = ("[Сообщение приложения, не от пользователя.] Урок закончился: вкладку закрыли или давно не пишут. "
             "Обнови конспект раздела <<SECTION>> инструментом repertoire_notes: что прошли в этом уроке, какие ходы "
             "решили играть, какие ошибки и что разобрать дальше; наблюдения об игроке вообще — в general. "
             "Перепиши конспект целиком, коротко и без повторов. Пользователю ничего не объясняй: в конце ответь одним словом «Готово».")


def _ok(data) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)}]}


def _err(msg: str) -> dict:
    return {"content": [{"type": "text", "text": msg}], "is_error": True}


def _schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


SECTION = {"type": "string", "description": "Section id ('r3', see repertoire_state); default: this lesson's section."}
COLOR = {"type": "string", "enum": list(COLORS), "description": "Which tree, when no section says it."}
AT = {"type": "string", "description": "Where in the tree: a node id ('n12'), 'start' (the initial position), moves from the initial "
                                       "position ('1.e4 e5 2.Nf3'), or 'section' (the section's position, the default)."}


def tools(chat_id: str) -> list:
    """The repertoire tools of one chat (added to its board server in chat.py)."""

    def guarded(fn):
        async def run(args):
            if S.lock:
                return _err(S.lock)
            try:
                return _ok(await fn(args))
            except (SceneError, ValueError, KeyError) as e:
                return _err(str(e))
        return run

    async def state(args):
        REP.ensure_seeded()
        pub = REP.public(trees=False)
        sec = REP.section(args["section"]) if args.get("section") else REP.lesson_section(chat_id)
        out: dict = {"sections": [{k: s[k] for k in ("id", "color", "name", "path", "status", "games", "score", "parent")}
                                  for s in pub["sections"]], "notes_general": REP.notes("general")}
        if sec:
            tree = REP.trees[sec["color"]]
            node = REP.node(sec)
            sub = {"id": "x", "seq": 0, "root": node}
            gl = REP.section_games(sec)
            out["section"] = {
                "id": sec["id"], "name": sec["name"], "color": sec["color"], "status": sec["status"],
                "moves_to_it": san_path(scenes.path_of(tree, node["id"])), "node": node["id"],
                "tree_from_it": scenes.pgn(sub, with_ids=True) or "(no moves after it yet)",
                "notes": REP.notes(sec["id"]),
                "games": REP.stats(sec, recent=12),
                "user_moves_in_games": _first_moves(gl, node, tree),
                "drill": REP.drill_summary(sec),
                "games_vs_tree": _games_vs_tree(REP.games_report(sec)),
            }
        return out

    async def add(args):
        sec, color = REP.pick(chat_id, args)
        tree = REP.trees[color]
        start = REP.at_node(tree, args.get("at"), sec)
        try:
            nodes = scenes.add_moves(tree, start, args.get("moves") or [], by="claude", title=args.get("title") or "",
                                     comment=args.get("comment") or "")
        except SceneError:
            if args.get("at") not in (None, "", "section") or start is tree["root"]:
                raise
            start = tree["root"]  # the moves were given from the initial position
            nodes = scenes.add_moves(tree, start, args.get("moves") or [], by="claude", title=args.get("title") or "",
                                     comment=args.get("comment") or "")
        REP.save()
        warn = []
        for n in nodes:
            parent = scenes.index(tree)[n["id"]][1]
            if parent and chess.Board(parent["fen"]).turn == (color == "white") and len(parent["children"]) > 1:
                warn.append(f"after {san_path(scenes.path_of(tree, parent['id'])) or 'the start'} the user now has "
                            f"{len(parent['children'])} own moves: " + ", ".join(c["san"] for c in parent["children"])
                            + " (the first is the main one; promote to change)")
        await REP.show_tree(tree, (nodes[-1] if nodes else start)["id"], chat_id)
        return {"ok": True, "tree": tree["id"], "added": san_path(scenes.path_of(tree, nodes[-1]["id"])) if nodes else "(nothing new)",
                **({"warning": warn} if warn else {})}

    async def edit(args):
        sec, color = REP.pick(chat_id, args)
        tree = REP.trees[color]
        node = REP.at_node(tree, args.get("at"), sec)
        action = args.get("action")
        goto = node["id"]
        if action == "promote":
            scenes.promote(tree, node["id"])
        elif action == "delete":
            REP.guard_delete(tree, node["id"])
            goto = scenes.delete(tree, node["id"])["id"]
        elif action == "comment":
            c = args.get("comment") or ""
            node["comment"] = (node.get("comment", "") + "\n\n" + c).strip() if args.get("append") else c
        elif action != "goto":
            raise SceneError("action must be promote | delete | comment | goto")
        REP.save()
        await REP.show_tree(tree, goto, chat_id)
        return {"ok": True, "node": goto, "path": san_path(scenes.path_of(tree, goto)) or "(start)"}

    async def section(args):
        action = args.get("action")
        if action == "create":
            color = args.get("color") or (REP.lesson_section(chat_id) or {}).get("color")
            if color not in COLORS:
                raise SceneError("create needs color")
            sec = REP.add_section(color, args.get("moves") or "", args.get("name") or "", by="claude")
        else:
            sec = REP.section(args.get("section"))
            if action == "rename":
                sec["name"] = (args.get("name") or "").strip() or sec["name"]
            elif action in ("retire", "restore"):
                sec["status"] = "retired" if action == "retire" else "active"
            else:
                raise SceneError("action must be create | rename | retire | restore")
        REP.save()
        await REP.emit()
        return {"ok": True, "section": {k: sec[k] for k in ("id", "name", "color", "status")}}

    async def notes(args):
        key = args.get("section") or (REP.lesson_section(chat_id) or {}).get("id") or "general"
        res = REP.write_notes(chat_id, key, args.get("text") or "", bool(args.get("append")))
        await REP.emit()
        return res

    async def play(args):
        sec = REP.section(args["section"]) if args.get("section") else REP.lesson_section(chat_id)
        if sec is None:
            raise SceneError("which section? pass `section`")
        b, ucis = chess.Board(), []
        for tok in scenes.split_moves(args.get("moves") or ""):
            m = scenes.parse_move(b, tok)
            ucis.append(m.uci())
            b.push(m)
        elo = int(args["elo"]) if args.get("elo") else None
        await broadcast({"type": "rep_play", "section": sec["id"], "moves": ucis, "elo": elo, "comment": args.get("comment") or "",
                         "by_chat": chat_id})
        return {"ok": True, "section": sec["name"], "user_plays": sec["color"], "line": san_path(_san_nodes(chess.Board(), ucis)) or "(the tree)",
                "note": "the game is on the user's board now; its moves do not come to you — the user tells you how it went or asks for a review"}

    return [
        tool("repertoire_play", "Start a training game against the engine on the user's board, in a section (default: this "
             "lesson's). `moves`: the line from the initial position to steer into (both sides' moves, e.g. a variation the "
             "user keeps missing); the app plays the opponent's moves of it while the user follows it, then the tree's, then "
             "Stockfish at about `elo` (default: the user's own choice). `comment`: a short goal shown above the game.",
             _schema({"section": SECTION, "moves": {"type": "string"}, "elo": {"type": "integer", "minimum": 1320, "maximum": 3200},
                      "comment": {"type": "string"}}))(guarded(play)),
        tool("repertoire_state", "The user's repertoire: sections (with games and score % in them), the general notes; for a "
             "section (default: this lesson's) its moves, its tree with node ids, your notes, the user's games in it and the "
             "moves they played there.", _schema({"section": SECTION}))(guarded(state)),
        tool("repertoire_add", "Write moves the user decided to play into a repertoire tree, from `at` (default: the section's "
             "position). Existing moves are reused. The window shows the tree at the last move.",
             _schema({"moves": {"description": "'4.c3 Nf6 5.d4' (SAN, numbers optional) or a list", "anyOf": [{"type": "string"}, {"type": "array"}]},
                      "at": AT, "section": SECTION, "color": COLOR, "comment": {"type": "string", "description": "why (on the first new move)"},
                      "title": {"type": "string", "description": "a short label shown before the line («Главная», «Если 3...c5»), not its moves"}}, ["moves"]))(guarded(add)),
        tool("repertoire_edit", "Change a repertoire tree at `at`: promote (main move), delete (the move and what follows; only "
             "when the user asks), comment (append=true adds), goto (show it to the user).",
             _schema({"action": {"type": "string", "enum": ["promote", "delete", "comment", "goto"]}, "at": AT, "section": SECTION,
                      "color": COLOR, "comment": {"type": "string"}, "append": {"type": "boolean"}}, ["action"]))(guarded(edit)),
        tool("repertoire_section", "Sections of the repertoire: create (color + moves from the initial position, name optional — "
             "the opening's name by default), rename, retire (the user no longer plays it), restore.",
             _schema({"action": {"type": "string", "enum": ["create", "rename", "retire", "restore"]}, "section": SECTION,
                      "color": COLOR, "moves": {"type": "string"}, "name": {"type": "string"}}, ["action"]))(guarded(section)),
        tool("repertoire_notes", "Write your notes (the memory between lessons): of a section (default: this lesson's) or "
             "'general'. Replaces them unless append=true.",
             _schema({"section": {"type": "string", "description": "section id or 'general'"}, "text": {"type": "string"},
                      "append": {"type": "boolean"}}, ["text"]))(guarded(notes)),
    ]


def _back_in(b: chess.Board, ucis: list[str], pos: dict) -> int:
    """How many of the next moves bring the game back to a position of the tree (another move order), 0 if they don't."""
    b = b.copy()
    for k, u in enumerate(ucis, 1):
        try:
            b.push(chess.Move.from_uci(u))
        except (ValueError, AssertionError):
            return 0
        if openings.key(b) in pos:
            return k
    return 0


def _games_vs_tree(rep: dict) -> dict:
    def line(x: dict, kind: str) -> str:
        where = f"after {x['before']}" if x["before"] else "at the start"
        if kind == "end":
            return f"{where}: the tree ends ({x['games']} games)"
        exp = f" instead of {' / '.join(x['expected'])}" if kind == "user" and x["expected"] else ""
        return f"{where}: {x['num']}{x['played']}{exp} ({x['games']} games)"
    return {"games": rep["games"], "counts": rep["counts"],
            "user_left_the_tree": [line(x, "user") for x in rep["user"]],
            "user_played_otherwise_before_the_move_was_in_the_tree": [line(x, "user") for x in rep["habit"]],
            "opponents_left_the_tree": [line(x, "opponent") for x in rep["opponent"]],
            "preparation_ended": [line(x, "end") for x in rep["end"]]}


def _first_moves(gl: list[dict], node: dict, tree: dict) -> list[str]:
    """What the user and the opponents played from the section's position in the games that reached it."""
    k = openings.key(chess.Board(node["fen"]))
    cnt: Counter = Counter()
    for g in gl:
        b = chess.Board()
        for i, u in enumerate(g["ucis"]):
            b.push(chess.Move.from_uci(u))
            if openings.key(b) == k:
                nxt = g["ucis"][i + 1: i + 5]
                if nxt:
                    cnt[scenes.path_text(_san_nodes(b, nxt))] += 1
                break
    return [f"{line} — {n}" for line, n in cnt.most_common(10)]


def _san_nodes(b: chess.Board, ucis: list[str]) -> list[dict]:
    b = b.copy()
    out = []
    for u in ucis:
        m = chess.Move.from_uci(u)
        out.append({"num": scenes.num_label(b), "san": b.san(m)})
        b.push(m)
    return out


# ---------------- HTTP (the window) ----------------
def route(fn):
    async def wrapper(request: Request):
        if S.lock:
            return JSONResponse({"error": S.lock}, status_code=423)
        try:
            b = await request.json() if request.method == "POST" else {}
        except ValueError:
            b = {}
        try:
            return JSONResponse(await fn(b))
        except (SceneError, ValueError, KeyError) as e:
            return JSONResponse({"error": str(e)}, status_code=400)
    return wrapper


@route
async def http_state(_: dict):
    REP.ensure_seeded()
    return REP.public()


@route
async def http_section(b: dict):
    action = b.get("action")
    if action == "create":
        color = b.get("color")
        if color not in COLORS:
            raise SceneError("color must be white or black")
        moves = b.get("at") or b.get("moves") or ""
        sec = REP.add_section(color, moves, b.get("name") or "", by="user")
        REP.save()
        await broadcast({"type": "scene", "scene": REP.trees[color], "goto": None})
    else:
        sec = REP.section(b.get("id"))
        if action == "rename":
            sec["name"] = (b.get("name") or "").strip() or sec["name"]
        elif action in ("retire", "restore"):
            sec["status"] = "retired" if action == "retire" else "active"
        elif action == "delete":  # the section goes; its moves stay in the tree, its lessons stay as chats
            REP.d["sections"].remove(sec)
            REP.d["notes"].pop(sec["id"], None)
            for cid in [c for c, les in REP.d["lessons"].items() if les["section"] == sec["id"]]:
                REP.d["lessons"].pop(cid)
        else:
            raise SceneError("action must be create | rename | retire | restore | delete")
        REP.save()
    await REP.emit()
    return {"ok": True, "section": sec}


@route
async def http_lesson(b: dict):
    chat = await REP.new_lesson(b["section"], b.get("model"), b.get("effort"))
    return chat.meta()


@route
async def http_drill(b: dict):
    card = REP.drill_answer(str(b.get("key", "")), bool(b.get("ok")))
    await broadcast({"type": "rep_drill", "key": b["key"], "card": card})
    return card


@route
async def http_games(b: dict):
    return REP.games_report(REP.section(b.get("section")))


@route
async def http_engine(b: dict):
    fen = str(b.get("fen") or "")
    try:
        chess.Board(fen)
    except ValueError as e:
        raise SceneError(f"bad FEN: {e}") from e
    elo = max(1320, min(int(b.get("elo") or 1500), 3200))
    mv = await anyio.to_thread.run_sync(PLAY.move, fen, elo)
    return {"uci": mv.uci(), "san": chess.Board(fen).san(mv)}


@route
async def http_check(b: dict):
    color = b.get("color")
    if color not in COLORS:
        raise SceneError("color must be white or black")
    return REP.check_game(color, [str(u) for u in b.get("moves") or []], date=int(time.time() * 1000))


@route
async def http_seed(_: dict):
    n = REP.seed()
    await broadcast({"type": "scene", "scene": REP.trees["white"], "goto": None})
    await broadcast({"type": "scene", "scene": REP.trees["black"], "goto": None})
    await REP.emit()
    return {"ok": True, "added": n}


ROUTES = [
    Route("/api/rep", http_state),
    Route("/api/rep/section", http_section, methods=["POST"]),
    Route("/api/rep/lesson", http_lesson, methods=["POST"]),
    Route("/api/rep/seed", http_seed, methods=["POST"]),
    Route("/api/rep/drill", http_drill, methods=["POST"]),
    Route("/api/rep/games", http_games, methods=["POST"]),
    Route("/api/rep/check", http_check, methods=["POST"]),
    Route("/api/rep/engine", http_engine, methods=["POST"]),
]
