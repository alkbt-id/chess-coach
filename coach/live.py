"""Live games on Lichess through the Board API: the user's normal account, the user makes every move,
the app only relays them (https://lichess.org/api#tag/Board).

The Lichess login is the app's one account link in coach/lichess.py (OAuth in the user's browser); its
token needs the `board:play` scope. One account event stream reports games starting and ending; each
live game has its own stream of moves and clocks.

Fair play: Lichess forbids any outside help during a game. While a real-time game is on, `S.lock`
holds a message and everything that could help is refused: Stockfish, the analysis board, puzzle
explanations, Claude's board tools and new chat messages (server.py, board.py, chat.py). Busy Claude
replies are interrupted when a game starts, and the window hides those panels.
"""

import asyncio
import contextlib
import json
import time

import chess
import httpx

from .board import S, broadcast
from .lichess import ACCOUNT, API, HEADERS, token
from .lichess import why as _why
from .scenes import num_label

SCOPE = "board:play"
# Lichess lobby presets the Board API may seek (rapid and classical); the computer also plays blitz
SEEK_PRESETS = [[10, 0], [10, 5], [15, 10], [30, 0], [30, 20]]
AI_PRESETS = [[5, 3], [10, 0], [10, 5], [15, 10], [30, 0]]
LOCK = ("Идёт партия на Lichess: анализ, Stockfish и Claude выключены до её конца — "
        "правила Lichess запрещают любую помощь во время партии.")


class LiveError(ValueError):
    pass


class Game:
    def __init__(self, info: dict) -> None:
        self.id: str = info.get("gameId") or info["id"]
        self.color: str = info.get("color") or "white"
        self.speed: str = info.get("speed") or ""
        # a game the Board API cannot play (e.g. blitz started on the site): the user plays it on lichess.org
        self.board_ok: bool = (info.get("compat") or {}).get("board", True)
        self.opponent: dict = info.get("opponent") or {}
        self.rated = bool(info.get("rated"))
        self.status: str = (info.get("status") or {}).get("name") or "started"
        self.winner: str | None = info.get("winner")
        self.rating_diff: int | None = None
        self.full: dict = {}
        self.state: dict = {}
        self.gone: dict | None = None
        self.at = time.time()
        self.started = time.time()
        self.task: asyncio.Task | None = None
        self._key: str | None = None
        self._moves: list[dict] = []

    @property
    def playing(self) -> bool:
        return self.status in ("created", "started") and self.speed != "correspondence"

    def apply(self, st: dict) -> None:
        if st.get("moves") != self.state.get("moves"):
            self.gone = None  # a move was played: the opponent is back at the board
        self.state = st
        self.status = st.get("status") or self.status
        self.winner = st.get("winner", self.winner)
        self.at = time.time()

    def start_fen(self) -> str:
        f = self.full.get("initialFen") or "startpos"
        return chess.STARTING_FEN if f == "startpos" else f

    def moves(self) -> list[dict]:
        key = self.state.get("moves", "")
        if key != self._key:
            board = chess.Board(self.start_fen())
            out = []
            for u in key.split():
                try:
                    mv = board.parse_uci(u)  # also takes king-to-rook castling (e1h1)
                except ValueError:
                    break
                num, san = num_label(board), board.san(mv)
                board.push(mv)
                out.append({"uci": mv.uci(), "san": san, "fen": board.fen(), "num": num})
            self._key, self._moves = key, out
        return self._moves

    def board(self) -> chess.Board:
        mv = self.moves()
        return chess.Board(mv[-1]["fen"] if mv else self.start_fen())

    def player(self, side: str) -> dict:
        p = self.full.get(side) or {}
        if not p and side != self.color and self.opponent:
            p = {"name": self.opponent.get("username"), "rating": self.opponent.get("rating"), "aiLevel": self.opponent.get("ai")}
        ai = p.get("aiLevel")
        name = p.get("name") or (f"Компьютер Lichess, уровень {ai}" if ai else "?")
        return {"name": name, "rating": p.get("rating"), "title": p.get("title"), "ai": ai,
                "provisional": bool(p.get("provisional")), "me": side == self.color}

    def public(self) -> dict:
        st = self.state
        clock = self.full.get("clock") or {}
        return {
            "id": self.id, "color": self.color, "speed": self.speed, "rated": self.full.get("rated", self.rated),
            "perf": (self.full.get("perf") or {}).get("name") or self.speed,
            "clock": {"initial": clock.get("initial"), "increment": clock.get("increment")} if clock else None,
            "white": self.player("white"), "black": self.player("black"),
            "startFen": self.start_fen(), "moves": self.moves(),
            "wtime": st.get("wtime"), "btime": st.get("btime"), "at": int(self.at * 1000),
            "status": self.status, "winner": self.winner, "playing": self.playing, "boardOk": self.board_ok,
            "loaded": bool(self.full), "ratingDiff": self.rating_diff,
            "drawOffer": "white" if st.get("wdraw") else "black" if st.get("bdraw") else None,
            "gone": self.gone, "url": f"https://lichess.org/{self.id}/{self.color}",
        }


class Live:
    def __init__(self) -> None:
        self.games: dict[str, Game] = {}
        self.current: str | None = None
        self.seek: dict | None = None
        self.seek_task: asyncio.Task | None = None
        self.events_task: asyncio.Task | None = None
        self.stream_ok = False
        self.error = ""
        self.was_live = False
        self._http: httpx.AsyncClient | None = None

    # ---------------- plumbing ----------------
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(base_url=API, headers=HEADERS, timeout=httpx.Timeout(15.0))
        return self._http

    def bearer(self) -> dict:
        tok = token()
        if not tok:
            raise LiveError("Lichess не подключён")
        return {"Authorization": f"Bearer {tok}"}

    def game(self) -> Game | None:
        """The live game, else the last one (kept for its review)."""
        live = [g for g in self.games.values() if g.playing]
        if live:
            return max(live, key=lambda g: g.started)
        return self.games.get(self.current) if self.current else None

    def live(self) -> bool:
        return any(g.playing for g in self.games.values())

    def public(self) -> dict:
        g = self.game()
        return {"connected": bool(token()), "scopeOk": ACCOUNT.has(SCOPE), "user": ACCOUNT.user(), "stream": self.stream_ok,
                "error": self.error, "seek": self.seek, "game": g.public() if g else None, "live": self.live(),
                "seekPresets": SEEK_PRESETS, "aiPresets": AI_PRESETS}

    async def emit(self) -> None:
        live = self.live()
        S.lock = LOCK if live else None
        if live and not self.was_live:
            await self._quiet_claude()
        self.was_live = live
        await broadcast({"type": "live", "state": self.public()})

    async def _quiet_claude(self) -> None:
        from .chat import CHATS  # late import: chat.py is not needed to load this module

        for c in list(CHATS.chats.values()):
            if c.busy:
                with contextlib.suppress(Exception):
                    await CHATS.interrupt(c.id)

    async def start(self) -> None:
        """Follow the account's games while the login may play (called at startup, after a login, and
        whenever the window asks)."""
        if token() and ACCOUNT.has(SCOPE) and (self.events_task is None or self.events_task.done()):
            self.events_task = asyncio.create_task(self._events())

    async def _ensure_events(self) -> None:
        if not token():
            raise LiveError("Lichess не подключён")
        if not ACCOUNT.has(SCOPE):
            raise LiveError("у входа в Lichess нет права играть партии — подключи Lichess заново")
        await self.start()
        for _ in range(60):
            if self.stream_ok:
                return
            if self.events_task is None or self.events_task.done():
                break
            await asyncio.sleep(0.1)
        raise LiveError(self.error or "нет связи с Lichess")

    async def close(self) -> None:
        tasks = [t for t in [self.events_task, self.seek_task, *(g.task for g in self.games.values())] if t and not t.done()]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ---------------- event stream: games starting and ending ----------------
    async def _events(self) -> None:
        delay = 2.0
        while (tok := token()) and ACCOUNT.has(SCOPE):
            wait = delay
            try:
                async with self.http().stream("GET", "/api/stream/event", headers={"Authorization": f"Bearer {tok}"},
                                              timeout=httpx.Timeout(15.0, read=40.0)) as r:  # keep-alive every 7 s
                    if r.status_code == 401:
                        if token() == tok:
                            ACCOUNT.forget()
                        self.error, self.stream_ok = "Lichess отозвал доступ — подключи аккаунт заново", False
                        await self.emit()
                        return
                    if r.status_code == 429:
                        self.error, wait = "Lichess просит подождать минуту: слишком много запросов", 60.0
                    elif r.status_code != 200:
                        await r.aread()
                        self.error = _why(r)
                    else:
                        self.stream_ok, self.error, delay = True, "", 2.0
                        await self.emit()
                        await self._recheck_external()
                        async for line in r.aiter_lines():
                            if line.strip():
                                await self._on_event(json.loads(line))
            except asyncio.CancelledError:
                self.stream_ok = False
                raise
            except httpx.ReadTimeout:
                wait = 1.0
            except (httpx.HTTPError, LiveError, ValueError) as e:
                self.error = f"нет связи с Lichess ({type(e).__name__}) — переподключаюсь"
            self.stream_ok = False
            await self.emit()
            await asyncio.sleep(wait)
            delay = min(delay * 2, 30.0)
        self.stream_ok = False

    async def _on_event(self, ev: dict) -> None:
        t = ev.get("type")
        info = ev.get("game") or {}
        gid = info.get("gameId") or info.get("id")
        if not gid:
            return
        if t == "gameStart":
            if info.get("speed") == "correspondence":
                return
            g = self.games.get(gid)
            if g is None:
                g = self.games[gid] = Game(info)
                self._prune()
            if self.seek:
                await self.cancel_seek(emit=False)
            self.current = gid
            if g.board_ok and (g.task is None or g.task.done()):
                g.task = asyncio.create_task(self._follow(g))
            await self.emit()
        elif t == "gameFinish" and gid in self.games:
            g = self.games[gid]
            if g.playing:
                g.status = (info.get("status") or {}).get("name") or "unknownFinish"
                if g.status in ("created", "started"):
                    g.status = "unknownFinish"
            g.winner = info.get("winner", g.winner)
            g.rating_diff = info.get("ratingDiff", g.rating_diff)
            await self.emit()

    def _prune(self) -> None:
        old = sorted((g for g in self.games.values() if not g.playing), key=lambda g: g.started)[:-4]
        for g in old:
            self.games.pop(g.id, None)

    async def _recheck_external(self) -> None:
        """After a reconnect: a site-only game may have ended while the stream was down."""
        for g in [g for g in self.games.values() if g.playing and not g.board_ok]:
            with contextlib.suppress(httpx.HTTPError, ValueError):
                r = await self.http().get(f"/game/export/{g.id}", params={"moves": "false"}, headers={"Accept": "application/json"})
                if r.status_code == 200 and r.json().get("status") not in ("created", "started"):
                    g.status, g.winner = r.json().get("status"), r.json().get("winner")

    # ---------------- one game: moves and clocks ----------------
    async def _follow(self, g: Game) -> None:
        delay = 1.0
        while token() and g.playing:
            try:
                async with self.http().stream("GET", f"/api/board/game/stream/{g.id}", headers=self.bearer(),
                                              timeout=httpx.Timeout(15.0, read=60.0)) as r:
                    if r.status_code != 200:
                        await r.aread()
                        raise LiveError(_why(r))
                    delay = 1.0
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        ev = json.loads(line)
                        kind = ev.get("type")
                        if kind == "gameFull":
                            g.full = ev
                            g.apply(ev.get("state") or {})
                        elif kind == "gameState":
                            g.apply(ev)
                        elif kind == "opponentGone":
                            g.gone = {"gone": bool(ev.get("gone")), "claimIn": ev.get("claimWinInSeconds"), "at": int(time.time() * 1000)}
                        else:
                            continue
                        await self.emit()
                continue  # the server closed the stream: the game ended (the loop checks) or reconnect
            except asyncio.CancelledError:
                raise
            except httpx.ReadTimeout:
                continue  # a quiet stretch with no data: reconnect, Lichess sends the full state again
            except (httpx.HTTPError, LiveError, ValueError) as e:
                self.error = f"партия: нет связи с Lichess ({e}) — переподключаюсь"
                await self.emit()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15.0)
        if self.error.startswith("партия:"):
            self.error = ""
            await self.emit()

    # ---------------- starting games ----------------
    async def start_seek(self, minutes: int, inc: int, rated: bool) -> None:
        if [minutes, inc] not in SEEK_PRESETS:
            raise LiveError("такой контроль нельзя искать через Board API: только рапид и классика")
        if self.live():
            raise LiveError("партия уже идёт")
        await self.cancel_seek(emit=False)
        await self._ensure_events()
        self.seek = {"time": minutes, "increment": inc, "rated": bool(rated), "since": int(time.time() * 1000)}
        self.error = ""
        self.seek_task = asyncio.create_task(self._seek(self.seek))
        await self.emit()

    async def _seek(self, sk: dict) -> None:
        data = {"time": sk["time"], "increment": sk["increment"], "rated": "true" if sk["rated"] else "false", "variant": "standard"}
        why = ""
        try:
            async with self.http().stream("POST", "/api/board/seek", data=data, headers=self.bearer(),
                                          timeout=httpx.Timeout(15.0, read=None)) as r:  # open = the seek is on
                if r.status_code != 200:
                    await r.aread()
                    why = _why(r)
                else:
                    async for _ in r.aiter_lines():
                        pass
                    await asyncio.sleep(2)  # the closed seek means a game: its start comes on the event stream
                    if not any(g.started * 1000 >= sk["since"] for g in self.games.values()):
                        why = "Соперник не нашёлся — попробуй ещё раз"
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, LiveError) as e:
            why = f"поиск соперника прервался ({e or type(e).__name__})"
        if self.seek is sk:
            self.seek, self.seek_task = None, None
            self.error = why
            await self.emit()

    async def cancel_seek(self, emit: bool = True) -> None:
        t = self.seek_task
        self.seek, self.seek_task = None, None
        if t and not t.done() and t is not asyncio.current_task():
            t.cancel()  # closing the connection cancels the seek on Lichess
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        if emit:
            await self.emit()

    async def play_ai(self, level: int, minutes: int, inc: int, color: str) -> None:
        if not 1 <= int(level) <= 8:
            raise LiveError("уровень компьютера — от 1 до 8")
        if [minutes, inc] not in AI_PRESETS:
            raise LiveError("неизвестный контроль времени")
        if color not in ("random", "white", "black"):
            raise LiveError("цвет: random, white или black")
        if self.live():
            raise LiveError("партия уже идёт")
        await self.cancel_seek(emit=False)
        await self._ensure_events()
        r = await self.http().post("/api/challenge/ai", headers=self.bearer(), data={
            "level": int(level), "clock.limit": minutes * 60, "clock.increment": inc, "color": color, "variant": "standard"})
        if r.status_code not in (200, 201):
            raise LiveError(_why(r))
        self.error = ""

    # ---------------- during the game ----------------
    def _mine(self, gid: str) -> Game:
        g = self.games.get(gid)
        if not g or not g.playing:
            raise LiveError("партия уже закончилась")
        if not g.board_ok:
            raise LiveError("эту партию можно играть только на lichess.org")
        return g

    async def move(self, gid: str, uci: str) -> None:
        g = self._mine(gid)
        board = g.board()
        try:
            mv = chess.Move.from_uci(uci)
        except ValueError:
            raise LiveError(f"непонятный ход {uci!r}") from None
        if ("white" if board.turn == chess.WHITE else "black") != g.color:
            raise LiveError("сейчас ход соперника")
        if mv not in board.legal_moves:
            raise LiveError(f"ход {uci} в этой позиции невозможен")
        r = await self.http().post(f"/api/board/game/{gid}/move/{mv.uci()}", headers=self.bearer())
        if r.status_code != 200:
            raise LiveError(_why(r))

    async def action(self, gid: str, act: str) -> None:
        paths = {"resign": "resign", "abort": "abort", "draw": "draw/yes", "decline": "draw/no", "claim": "claim-victory"}
        if act not in paths:
            raise LiveError(f"неизвестное действие {act!r}")
        self._mine(gid)
        r = await self.http().post(f"/api/board/game/{gid}/{paths[act]}", headers=self.bearer())
        if r.status_code != 200:
            raise LiveError(_why(r))


L = Live()
