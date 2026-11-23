"""Chats with Claude inside the app (Claude Agent SDK = Claude Code as a library).

Each chat is a Claude Code session in the project folder, signed in with the user's own Claude Code
login (no API key). It gets in-process tools for the board, Stockfish, the puzzle trainer and the
background jobs. Other Claude Code tools run in Claude Code's auto mode: a classifier approves safe calls
by itself; only a call it would not approve on its own comes to the user as a permission card in the chat.
Transcripts for display are kept in app/chats/<id>.json of the data folder (coach/config.py); the Claude session id lets a chat
continue after the app restarts.
"""

import asyncio
import contextlib
import itertools
import warnings
import json
import time
import uuid

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    tool,
)

from . import board, config, jobs, repertoire
from .board import DATA, S, broadcast, load_json, save_json
from .config import ROOT
from .scenes import SceneError

MODELS = [
    {"id": "claude-opus-5-5", "name": "Opus 5.5"},
    {"id": "claude-sonnet-5-5", "name": "Sonnet 5.5"},
    {"id": "claude-haiku-5-5", "name": "Haiku 5.5"},
    {"id": "claude-fable-5-2", "name": "Fable 5.2"},
]
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
# allowed_tools auto-approves the board tools and read-only tools on purpose
warnings.filterwarnings("ignore", message="can_use_tool will not be invoked")
DEFAULT_MODEL, DEFAULT_EFFORT = "claude-opus-5-5", "high"
CHATS_DIR = DATA / "chats"

SYSTEM_APPEND = """
# You are inside the desktop app «Шахматный тренер»
The user talks to you in the app's chat panel; next to it is a chess board they are looking at.
<<USER>>
Reply in Russian, short and concrete; the chat renders Markdown. Moves in SAN with numbers (25.a4 Ng2 26.Kb3):
the app makes them clickable and shows the line on the board, so always write lines from a position that is
on the board (the current diagram or puzzle).
Every move or line you write — in a reply or in a board comment — also carries the moves that lead to it, hidden
from the reader, so a click shows exactly the position you mean. Write it as a Markdown link: the moves you show in
brackets, then `#` and every move from the diagram start up to them, with numbers: [3...Bf5](#1.d4 d5 2.c4 dxc4 3.e3)
— the user sees only «3...Bf5». A line from the diagram start itself: [1.d4 d5 2.c4](#). Do it for every mention,
a single move and a move without a number too ([Qb3](#1.d4 d5 2.c4 dxc4 3.e3 Bf5)); for a line about another board
of this chat — from that board's start; for moves before the diagram start — from the game's first move. Only moves
go in the brackets, the words stay outside: после [2...dxc4 3.e3](#1.d4 d5 2.c4) ты играл [3...Bf5](#1.d4 d5 2.c4 dxc4 3.e3).
Tell a line in the order it is played and never skip moves: the reader follows the move numbers. A reply to
10.Bg5+ is a move 10... (10...Ke8), never 12...Nxc2+. To get to a move deeper in the line, write every move
up to it (10.Bg5+ Ke8 11.Qh5 Nd4 12.Bd3 Nxc2+), then explain.

## Tone
Talk like a friendly, respectful coach. Never call the user's moves, ideas or play «тупой», «глупый», «ужасный»
or anything like it — even when the user uses such a word: from them it is frustration, not permission.
Name a mistake neutrally («ошибка», «неточность», «зевок») and explain what it missed and what to look at next time.

## Show, don't just tell
- Read `board_state` first whenever the user means "this position", «поясни», «почему», «а если».
- Put positions, lines and arrows on the board with `show`, `add_line`, `annotate`, `goto`. The study board is a
  Lichess-style move tree: the first line is the main line, others are variations. One idea per comment.
- Never state a line or an evaluation you have not checked with `analyse` (Stockfish). Explain plans and ideas
  in human terms; numbers only as support.
- Ask questions in plain text (there is no question tool here).

## This chat's boards
This chat keeps its own boards, each with its own move tree; the user switches between them with tabs above the tree.
`board_state` lists them. `add_line`, `annotate`, `goto`, `edit` act on the chat's active board (the one the user
switched to last, or the one you made or picked last); pass `board` to work on another board of this chat.
A position that follows from a board goes into its tree as a variation. A position that does not (the next lesson,
another opening, a new example) goes on a new board: `show` adds one to this chat and makes it active; the older
boards stay as they are. Never clear or reuse a board for an unrelated position.

## Live games
The «Игра» mode plays real games on the user's Lichess account. Lichess forbids any outside help during a game,
so while one is on every board tool is refused and the chat is closed. Never help with a game in progress;
after it ends, its moves are a normal diagram you can review.

## Data and jobs
- The user's data is outside the project, in <<HOME>>: lichess/games.ndjson (games),
  analysis/moves.jsonl (Stockfish per move), puzzles.json (puzzles), config.toml (settings).
  The jobs are scripts/*.py in the project (fetch_games, analyze, make_puzzles, report).
- Long work runs as a background job: `run_job` (fetch_games, analyze, make_puzzles, update = all three, report);
  you get a message when it finishes. Use Read/Grep/Bash for anything else; risky tools ask the user first.
"""


def user_line() -> str:
    """Who the user is, for Claude: the Lichess account with its ratings and the `about` note from config.toml."""
    name = config.lichess_user()
    if not name:
        return "User: Lichess account not known yet (not signed in to Lichess in the app, no lichess_user in config.toml)."
    prof = load_json(config.PROFILE, {})
    if (prof.get("id") or "").lower() != name:
        prof = {}  # the profile of another account, before fetch_games refreshes it
    perfs = prof.get("perfs") or {}
    ratings = [f"{k} {p['rating']}" for k in ("bullet", "blitz", "rapid", "classical", "puzzle")
               if (p := perfs.get(k)) and p.get("games")]
    about = config.about().rstrip(".")
    return (f"User: Lichess {prof.get('username') or name}" + "".join(f", {r}" for r in ratings)
            + (f" — {about}" if about else "") + ".")


def summarize_input(name: str, inp: dict) -> str:
    if name == "Bash":
        return inp.get("command", "")[:300]
    if name in ("Write", "Edit", "Read", "NotebookEdit"):
        return inp.get("file_path", "")
    if name in ("WebFetch",):
        return inp.get("url", "")
    if name == "WebSearch":
        return inp.get("query", "")
    if name.startswith("mcp__board__"):
        return {k: v for k, v in inp.items() if k in ("title", "position", "at", "moves", "action", "kind")}.__repr__()[:200]
    return json.dumps(inp, ensure_ascii=False)[:200]


def perm_key(name: str, inp: dict) -> tuple[str | None, str]:
    """What an "always allow" answer remembers, like Claude Code's permission rules:
    a command prefix for Bash, one file for edits, one site for web fetches.
    Returns (key, label); key None means "always" is not offered (compound shell commands)."""
    if name == "Bash":
        cmd = (inp.get("command") or "").strip()
        if not cmd or any(op in cmd for op in (";", "&&", "||", "|", "`", "$(", ">", "<", "\n")):
            return None, ""
        prefix = " ".join(cmd.split()[:2])
        return f"Bash:{prefix}", f"команды «{prefix} …»"
    if name in ("Write", "Edit", "NotebookEdit"):
        path = inp.get("file_path") or inp.get("notebook_path") or ""
        return f"{name}:{path}", f"файла {path}"
    if name == "WebFetch":
        from urllib.parse import urlparse
        host = urlparse(inp.get("url") or "").hostname or ""
        return f"WebFetch:{host}", f"сайта {host}"
    return name, f"инструмента {name}"


# ---------------- in-process tools for Claude ----------------
def _ok(data) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)}]}


def _err(msg: str) -> dict:
    return {"content": [{"type": "text", "text": msg}], "is_error": True}


SHAPES = {
    "type": "array", "items": {"type": "string"},
    "description": "Arrows/circles: 'e2e4' (green arrow), 'e2e4:red', 'f7:yellow' (circle), 'f7:red:!' (with a 1–3 char label). "
                   "Colors: green = good/plan, red = threat/bad, blue = alternative, yellow = attention, orange, purple.",
}
AT = {"type": "string", "description": "Node: 'start', 'current' (what the user sees), a node id like 'n12', or moves from the diagram start ('25.a4 Ng2')."}
MOVES = {
    "description": "Moves: '25.a4 Ng2 26.Kb3' (SAN or UCI, numbers optional, !/? glyphs allowed) or a list of strings / "
                   "{move, comment, shapes, glyph} to annotate single moves.",
    "anyOf": [{"type": "string"}, {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object"}]}}],
}


def _schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


BOARD = {"type": "string", "description": "One of this chat's boards by id ('s12', see board_state); default: the active board. "
                                          "A board picked here becomes the active one."}


def make_tools(chat_id: str):
    async def call(name: str, args: dict, own: bool = False):
        """own: the op acts on a board of this chat (`board`, else the active one), never on another chat's."""
        try:
            if own:
                args = dict(args)
                picked = args.pop("board", None)
                sc = board.chat_scene(chat_id, picked)
                if sc is None:
                    raise SceneError("this chat has no board yet: create one with show")
                args["scene"] = sc["id"]
                if picked and not S.lock:
                    await board.set_chat_board(chat_id, sc["id"])
            return _ok(await board.call_op(name, args))
        except (SceneError, ValueError) as e:
            return _err(str(e))

    @tool("board_state", "What the user sees now: mode (study/puzzle), board FEN and text diagram, the study tree (PGN with node ids "
          "[nX], user's own moves marked ·user) and the node they are on, or the puzzle with engine data and their tries; "
          "and this chat's boards: which one is active and which is on screen.", _schema({}))
    async def board_state(args):
        try:
            out = await board.call_op("board_state", args)
        except SceneError as e:
            return _err(str(e))
        out.pop("recent_diagrams", None)  # other chats' boards are not this chat's business
        active = board.chat_scene(chat_id)
        shown = (out.get("study") or {}).get("scene")
        out["this_chat_boards"] = [{"board": s["id"], "title": s["title"], **({"active": True} if s is active else {}),
                                    **({"on_screen": True} if s["id"] == shown else {})}
                                   for s in board.chat_scenes(chat_id)] or "none yet: show creates the first one"
        if active is not None and active["id"] != shown:  # the user went to another board or mode while this chat worked
            out["active_board"] = {"board": active["id"], "title": active["title"], "tree": board.tree_text(active)}
        return _ok(out)

    @tool("show", "Add a new board to this chat (study mode) with a position and lines; it becomes the active board and comes on screen. "
          "The chat's other boards stay as they are. Use it for a position that does not follow from an existing board. "
          "Lines become a Lichess-style tree: the first is the main line, later ones variations; a line's 'at' starts it deeper in the tree.",
          _schema({
              "title": {"type": "string"},
              "position": {"type": "string", "description": "'start', 'current', a FEN, or moves from the initial position. "
                           "For a position from a game give the moves: the board keeps them, so moves before it "
                           "(«после 5...Bg7») stay clickable in text. A FEN from the user's games finds its moves by itself."},
              "lines": {"type": "array", "items": {"type": "object", "properties": {
                  "moves": MOVES, "title": {"type": "string", "description": "short label shown before the line"},
                  "comment": {"type": "string"}, "shapes": SHAPES, "at": AT}}},
              "comment": {"type": "string", "description": "Text for the whole diagram (Markdown)."},
              "shapes": SHAPES,
              "orientation": {"type": "string", "enum": ["white", "black"]},
              "goto": AT,
          }, ["title"]))
    async def show(args):
        return await call("show", {**args, "chat": chat_id})

    @tool("add_line", "Add moves to a board of this chat (default: the active one) from node `at` (default: start); existing moves "
          "are reused, new ones become a variation. The board jumps to its first new move.",
          _schema({"moves": MOVES, "at": AT, "title": {"type": "string"}, "comment": {"type": "string"}, "shapes": SHAPES,
                   "board": BOARD}, ["moves"]))
    async def add_line(args):
        return await call("add_line", args, own=True)

    @tool("annotate", "Set comment / arrows / glyph (!, ?, !!, ??, !?, ?!) on a node of a board of this chat (default: the active "
          "board, the node the user is on) and show it. append=true adds instead of replacing. title renames the board.",
          _schema({"at": AT, "comment": {"type": "string"}, "shapes": SHAPES, "glyph": {"type": "string"},
                   "append": {"type": "boolean"}, "title": {"type": "string"}, "board": BOARD}))
    async def annotate(args):
        return await call("annotate", args, own=True)

    @tool("goto", "Show the user a node of a board of this chat (default: the active board); with `board`, switches to that board.",
          _schema({"at": AT, "board": BOARD}))
    async def goto(args):
        return await call("goto", args, own=True)

    @tool("edit", "Change a board's tree (default: the active board): 'promote' makes the line through `at` the main line, "
          "'delete' removes `at` and what follows.",
          _schema({"at": AT, "action": {"type": "string", "enum": ["promote", "delete"]}, "board": BOARD}, ["action"]))
    async def edit(args):
        return await call("edit", args, own=True)

    @tool("analyse", "Stockfish: top lines with eval (side to move, pawns) and win %. position: 'current' (user's board), FEN, "
          "or moves from the start. threat=true also gives the opponent's threat (null move).",
          _schema({"position": {"type": "string"}, "lines": {"type": "integer"}, "seconds": {"type": "number"},
                   "threat": {"type": "boolean"}}))
    async def analyse(args):
        return await call("analyse", args)

    @tool("puzzles", "Puzzle trainer (positions from the user's games): action 'stats', 'failing' (most failed), 'open' (id), "
          "'resume' (back to puzzle mode).",
          _schema({"action": {"type": "string", "enum": ["stats", "failing", "open", "resume"]}, "id": {"type": "string"}}, ["action"]))
    async def puzzles(args):
        return await call("puzzles", args)

    @tool("run_job", "Start a background job: fetch_games (new Lichess games), analyze (Stockfish over new games), make_puzzles "
          "(puzzles from new errors), update (all three), report (error statistics). Returns at once; you get a message when it ends.",
          _schema({"kind": {"type": "string", "enum": list(jobs.KINDS)}}, ["kind"]))
    async def run_job(args):
        try:
            job = await jobs.start(args["kind"], chat_id)
        except ValueError as e:
            return _err(str(e))
        return _ok({"started": job.public()})

    @tool("job_status", "Status and last output lines of background jobs (all, or one id).", _schema({"id": {"type": "string"}}))
    async def job_status(args):
        if args.get("id"):
            j = jobs.JOBS.get(args["id"])
            return _ok(j.public(40)) if j else _err("no such job")
        return _ok([j.public() for j in jobs.JOBS.values()])

    return create_sdk_mcp_server("board", tools=[board_state, show, add_line, annotate, goto, edit, analyse, puzzles, run_job, job_status,
                                                 *repertoire.tools(chat_id)])


# ---------------- chats ----------------
class Chat:
    def __init__(self, meta: dict) -> None:
        self.id: str = meta["id"]
        self.title: str = meta.get("title") or "Новый чат"
        self.model: str = meta.get("model") or DEFAULT_MODEL
        self.effort: str = meta.get("effort") or DEFAULT_EFFORT
        self.session_id: str | None = meta.get("session_id")
        self.created: float = meta.get("created") or time.time()
        self.updated: float = meta.get("updated") or self.created
        self.cost: float = meta.get("cost") or 0.0
        self.about: str | None = meta.get("about")  # the key of what it was started about ("puzzle:<id>", "play"…)
        self.entries: list[dict] = load_json(CHATS_DIR / f"{self.id}.json", [])
        # a reply cut off by an app restart: close what was left open
        cut = False
        for e in self.entries:
            if e.get("kind") == "tool" and e.get("status") == "running":
                e["status"], e["error"], cut = "error", "прервано перезапуском приложения", True
            if e.get("streaming"):
                e.pop("streaming")
                cut = True
            if e.get("kind") == "permission" and e.get("state") == "pending":
                e["state"], cut = "denied", True
        if cut:
            self.entries.append({"id": f"e{len(self.entries) + 1}", "ts": time.time(), "kind": "note",
                                 "text": "Ответ прервался: приложение перезапускалось. Отправь вопрос ещё раз."})
        self.seq = itertools.count(len(self.entries) + 1)
        # Messages wait here until Claude takes them; only then they enter the log, so the log keeps the real order.
        # A waiting message with a `key` can be replaced by a newer one (the user's line grew: ask once about all of it).
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self.waiting: list[dict] = []
        self.worker: asyncio.Task | None = None
        self.client: ClaudeSDKClient | None = None
        self.busy = False
        self.closing = False  # closed during a reply: stop Claude once the reply is done
        self.perms: dict[str, asyncio.Future] = {}
        self.always: set[str] = set()
        self.streaming: list[dict] = []

    def meta(self) -> dict:
        return {"id": self.id, "title": self.title, "model": self.model, "effort": self.effort, "session_id": self.session_id,
                "created": self.created, "updated": self.updated, "cost": round(self.cost, 4), "busy": self.busy,
                **({"about": self.about} if self.about else {})}

    def info(self) -> dict:
        """meta + what waits for Claude (not saved: the queue lives only while the app runs)"""
        return {**self.meta(), "queued": [{"text": w["note"] or w["text"], "note": bool(w["note"])} for w in self.waiting]}

    def save(self) -> None:
        save_json(CHATS_DIR / f"{self.id}.json", self.entries)


# A chat follows what is on screen (app.js followActivity): a board's chat is sc["chat"], a lesson's is in the
# repertoire; anything else that has a chat of its own — a puzzle, a Lichess puzzle, a game in «Игра», the
# repertoire's contents, the lobby of «Игра» — finds it by a key in S.settings["chat_for"] ("puzzle:<id>",
# "lpuzzle:<id>", "game:<id>", "rep", "play"). There are no chat tabs to close: a chat that has been off every
# screen for OFF_SCREEN seconds is closed by the server (its `claude` process ends, a lesson writes its notes).
OFF_SCREEN = 600


class ChatManager:
    def __init__(self) -> None:
        metas = load_json(DATA / "chats.json", [])
        self.chats: dict[str, Chat] = {m["id"]: Chat(m) for m in metas}
        self.shown: dict[str, float] = {}  # chat id -> when a window last reported it on screen
        self.task: asyncio.Task | None = None
        jobs.on_finish(self._job_finished)

    # ---- bookkeeping ----
    def save_meta(self) -> None:
        save_json(DATA / "chats.json", [c.meta() for c in self.chats.values()])

    def listing(self) -> list[dict]:
        return sorted((c.info() for c in self.chats.values()), key=lambda m: -m["updated"])

    async def emit_list(self) -> None:
        await broadcast({"type": "chat_list", "chats": self.listing()})

    async def add_entry(self, chat: Chat, entry: dict, save: bool = True) -> dict:
        entry = {"id": f"e{next(chat.seq)}", "ts": time.time(), **entry}
        chat.entries.append(entry)
        if save:
            chat.save()
        await broadcast({"type": "chat_entry", "chat": chat.id, "entry": entry})
        return entry

    async def update_entry(self, chat: Chat, entry: dict, save: bool = True) -> None:
        if save:
            chat.save()
        await broadcast({"type": "chat_entry", "chat": chat.id, "entry": entry})

    # ---- API ----
    async def create(self, model: str | None = None, effort: str | None = None, about: str | None = None) -> Chat:
        cid = uuid.uuid4().hex[:10]
        chat = Chat({"id": cid, "model": model or DEFAULT_MODEL, "effort": effort or DEFAULT_EFFORT, "about": about})
        self.chats[cid] = chat
        self.save_meta()
        await self.emit_list()
        return chat

    async def delete(self, cid: str) -> None:
        chat = self.chats.pop(cid, None)
        if chat:
            await self._stop_worker(chat)
            (CHATS_DIR / f"{cid}.json").unlink(missing_ok=True)
            self.save_meta()
            await board.unbind_chat(cid)
            keys = S.settings.get("chat_for") or {}
            if any(v == cid for v in keys.values()):
                S.settings["chat_for"] = {k: v for k, v in keys.items() if v != cid}
                S.save_settings()
                await broadcast({"type": "chat_for", "map": S.settings["chat_for"]})
            await self.emit_list()

    def chat_for(self, key: str | None) -> "Chat | None":
        cid = (S.settings.get("chat_for") or {}).get(key) if key else None
        return self.chats.get(cid) if cid else None

    async def bind_for(self, key: str, cid: str) -> None:
        S.settings.setdefault("chat_for", {})[key] = cid
        S.save_settings()
        await broadcast({"type": "chat_for", "map": S.settings["chat_for"]})

    # ---- chats off screen ----
    def seen(self, cid: str | None) -> None:
        if cid in self.chats:
            self.shown[cid] = time.time()

    async def sweep(self) -> None:
        """Close the chats whose Claude is idle and that no window has shown for OFF_SCREEN seconds."""
        now = time.time()
        for chat in list(self.chats.values()):
            alive = chat.worker is not None and not chat.worker.done()
            if not alive or chat.busy or chat.waiting or chat.closing or chat.id == S.view.get("chat"):
                continue
            if now - max(self.shown.get(chat.id, 0), chat.updated) >= OFF_SCREEN:
                with contextlib.suppress(Exception):
                    await self.close(chat.id)

    async def watch(self) -> None:
        while True:
            await asyncio.sleep(60)
            await self.sweep()

    def start(self) -> None:
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.watch())

    async def close(self, cid: str) -> None:
        """The chat left the screen a while ago (sweep): the chat and its history stay, its `claude` process ends
        (so Claude Limits stops listing it); the next message resumes the session. A reply in progress is let
        finish first."""
        chat = self.chats.get(cid)
        if not chat:
            return
        # a lesson of the repertoire: Claude brings its notes up to date after what is still queued, then stops
        notes = not S.lock and (repertoire.REP.notes_due(chat)
                                or (cid in repertoire.REP.d["lessons"] and any(not w["note"] for w in chat.waiting)))
        if notes:
            await repertoire.REP.ask_notes(chat)
        if chat.busy or chat.waiting:
            chat.closing = True
        else:
            await self._stop_worker(chat)

    async def configure(self, cid: str, model: str | None, effort: str | None) -> None:
        chat = self.chats[cid]
        changed = False
        if model and model != chat.model:
            chat.model, changed = model, True
        if effort and effort in EFFORTS and effort != chat.effort:
            chat.effort, changed = effort, True
        if changed:
            if not chat.busy and not chat.waiting:
                await self._stop_worker(chat)  # restarts with the new settings on the next message
            self.save_meta()
            await self.emit_list()

    async def send(self, cid: str, text: str, *, note: str | None = None, key: str | None = None,
                   supersedes: list[str] | None = None) -> None:
        """Queue a message for Claude. With `note`, the chat shows that short note instead of the text.
        `key` names the message; a still waiting message whose key is in `supersedes` is replaced by this one
        (the user played on: one question about the whole line instead of one per move)."""
        if S.lock:  # a live Lichess game: no outside help (coach/lichess.py)
            raise ValueError(S.lock)
        chat = self.chats[cid]
        if not note and chat.title == "Новый чат":
            chat.title = text.strip().split("\n")[0][:48] or "Чат"
        chat.updated = time.time()
        chat.closing = False
        old = next((w for w in chat.waiting if w["key"] and w["key"] in (supersedes or [])), None)
        if old:
            old.update(text=text, note=note, key=key)
        else:
            item = {"text": text, "note": note, "key": key}
            chat.waiting.append(item)
            chat.queue.put_nowait(item)
        self.save_meta()
        if chat.worker is None or chat.worker.done():
            chat.worker = asyncio.create_task(self._work(chat))
        await self.emit_list()

    async def interrupt(self, cid: str) -> None:
        chat = self.chats[cid]
        for fut in chat.perms.values():
            if not fut.done():
                fut.set_result((False, False))
        if chat.client and chat.busy:
            try:
                await chat.client.interrupt()
            except Exception:  # noqa: BLE001
                await self._stop_worker(chat)

    async def answer(self, cid: str, req: str, allow: bool, always: bool) -> None:
        fut = self.chats[cid].perms.get(req)
        if fut and not fut.done():
            fut.set_result((allow, always))

    # ---- worker ----
    async def _stop_worker(self, chat: Chat) -> None:
        if chat.worker and not chat.worker.done():
            chat.worker.cancel()
            try:
                await chat.worker
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        chat.worker = None
        chat.client = None
        chat.busy = False

    def _options(self, chat: Chat) -> ClaudeAgentOptions:
        async def can_use_tool(name: str, inp: dict, _ctx):
            key, label = perm_key(name, inp)
            if key and key in chat.always:
                return PermissionResultAllow()
            req = uuid.uuid4().hex[:8]
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            chat.perms[req] = fut
            entry = await self.add_entry(chat, {"kind": "permission", "req": req, "tool": name,
                                                "summary": summarize_input(name, inp), "state": "pending",
                                                "what": (inp.get("description") or "").strip() if name == "Bash" else "",
                                                "always_label": label if key else ""})
            allow, always = await fut
            chat.perms.pop(req, None)
            entry["state"] = "allowed" if allow else "denied"
            await self.update_entry(chat, entry)
            if allow and always and key:
                chat.always.add(key)
            if allow:
                return PermissionResultAllow()
            return PermissionResultDeny(message="Пользователь не разрешил это действие.")

        return ClaudeAgentOptions(
            model=chat.model,
            effort=chat.effort,  # type: ignore[arg-type]
            cwd=str(ROOT),
            add_dirs=[str(config.HOME)],  # the user's data lives outside the project (coach/config.py)
            resume=chat.session_id,
            system_prompt={"type": "preset", "preset": "claude_code", "append": SYSTEM_APPEND.replace("<<USER>>", user_line()).replace("<<HOME>>", str(config.HOME))
                                                                   + repertoire.REP.prompt(chat.id)},
            setting_sources=["user", "project", "local"],
            mcp_servers={"board": make_tools(chat.id)},
            allowed_tools=["mcp__board", "Read", "Glob", "Grep", "TodoWrite"],
            disallowed_tools=["AskUserQuestion", "mcp__chess-board", "ExitPlanMode", "EnterPlanMode"],
            permission_mode="auto",  # the user asked not to approve every command by hand (2026-11-22)
            can_use_tool=can_use_tool,
            include_partial_messages=True,
            stderr=lambda _line: None,
            # The Claude Limits menu bar app reads this from the process and opens it on a click:
            # the app comes forward and switches to this chat (mac/main.swift handles chess-coach://).
            env={"CLAUDE_LIMITS_OPEN_URL": f"chess-coach://chat?id={chat.id}"},
        )

    async def _work(self, chat: Chat) -> None:
        try:
            async with ClaudeSDKClient(options=self._options(chat)) as client:
                chat.client = client
                while True:
                    item = await chat.queue.get()
                    chat.waiting.remove(item)
                    if item["note"]:
                        await self.add_entry(chat, {"kind": "note", "text": item["note"]})
                    else:
                        await self.add_entry(chat, {"kind": "user", "text": item["text"]})
                    chat.busy = True
                    await self.emit_list()
                    try:
                        await client.query(item["text"])
                        async for msg in client.receive_response():
                            await self._handle(chat, msg)
                    except Exception as e:  # noqa: BLE001
                        await self.add_entry(chat, {"kind": "error", "text": f"Ошибка: {e}"})
                    finally:
                        chat.busy = False
                        chat.streaming = []
                        chat.updated = time.time()
                        self.save_meta()
                        await self.emit_list()
                    if chat.closing and chat.queue.empty():  # it was closed during the reply
                        chat.closing = False
                        break
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            await self.add_entry(chat, {"kind": "error", "text": f"Не удалось запустить Claude: {e}"})
        finally:
            chat.client = None
            chat.busy = False
            await self.emit_list()

    async def _handle(self, chat: Chat, msg) -> None:
        if isinstance(msg, SystemMessage):
            sid = (msg.data or {}).get("session_id")
            if sid and sid != chat.session_id:
                chat.session_id = sid
                self.save_meta()
            return
        if isinstance(msg, StreamEvent):
            if msg.parent_tool_use_id:
                return
            ev = msg.event
            if ev.get("type") == "content_block_start" and ev.get("content_block", {}).get("type") == "text":
                entry = await self.add_entry(chat, {"kind": "assistant", "text": "", "streaming": True}, save=False)
                chat.streaming.append(entry)
            elif ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta" and chat.streaming:
                entry = chat.streaming[-1]
                entry["text"] += ev["delta"]["text"]
                await broadcast({"type": "chat_delta", "chat": chat.id, "entry": entry["id"], "text": ev["delta"]["text"]})
            return
        if isinstance(msg, AssistantMessage):
            if msg.parent_tool_use_id:
                return
            streamed = list(chat.streaming)
            chat.streaming = []
            for block in msg.content:
                if isinstance(block, TextBlock):
                    if streamed:
                        entry = streamed.pop(0)
                        entry["text"] = block.text
                        entry.pop("streaming", None)
                        await self.update_entry(chat, entry)
                    elif block.text.strip():
                        await self.add_entry(chat, {"kind": "assistant", "text": block.text})
                elif isinstance(block, ToolUseBlock):
                    await self.add_entry(chat, {"kind": "tool", "tool_id": block.id, "name": block.name,
                                                "summary": summarize_input(block.name, block.input or {}), "status": "running",
                                                "what": ((block.input or {}).get("description") or "").strip() if block.name == "Bash" else ""})
            for entry in streamed:  # streamed text the final message did not carry
                entry.pop("streaming", None)
                await self.update_entry(chat, entry)
            return
        if isinstance(msg, UserMessage):
            if msg.parent_tool_use_id or not isinstance(msg.content, list):
                return
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    for entry in reversed(chat.entries):
                        if entry.get("kind") == "tool" and entry.get("tool_id") == block.tool_use_id:
                            entry["status"] = "error" if block.is_error else "ok"
                            if block.is_error:
                                text = block.content if isinstance(block.content, str) else json.dumps(block.content, ensure_ascii=False)
                                entry["error"] = (text or "")[:300]
                            await self.update_entry(chat, entry)
                            break
            return
        if isinstance(msg, ResultMessage):
            if msg.session_id:
                chat.session_id = msg.session_id
            chat.cost += msg.total_cost_usd or 0.0
            if msg.is_error:
                errs = "; ".join(msg.errors or []) if getattr(msg, "errors", None) else (msg.result or msg.subtype)
                await self.add_entry(chat, {"kind": "error", "text": f"Claude остановился: {errs}"})
            self.save_meta()

    async def _job_finished(self, job) -> None:
        if not job.chat or job.chat not in self.chats:
            return
        status = {"done": "завершена", "failed": "упала", "cancelled": "остановлена"}.get(job.status, job.status)
        tail = "\n".join(list(job.lines)[-15:])
        await self.send(job.chat, f"[Фоновая задача «{job.title}» {status}. Последние строки вывода:\n{tail}\n]\n"
                                  "Коротко сообщи пользователю результат.", note=f"Фоновая задача «{job.title}» {status}")


CHATS = ChatManager()
