"""Local HTTP server behind the desktop window (127.0.0.1; the home network only with a key, coach/lan.py).

UI: static files, /api/state, /api/events (SSE), /api/view (what the window shows), puzzle progress and
explanations, study tree edits, chats, jobs. Claude Code outside the app reaches the same board
operations through POST /api/op/<name> (see coach/mcp_server.py).
"""

import asyncio
import contextlib
import html
import json
import os
import time
from pathlib import Path

import anyio
import httpx
from sse_starlette import EventSourceResponse
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import board, explain, jobs, lan, lichess, live, repertoire, review
from .lichess_puzzles import LP, THEME_RU, pick_weak, weak_themes
from .board import DATA, S, broadcast, save_json
from .chat import CHATS, EFFORTS, MODELS
from .engine import ENGINE
from .scenes import SceneError

WEB = Path(__file__).resolve().parent / "web"
PORT = int(os.environ.get("COACH_PORT", "8737"))


def err(msg: str, code: int = 400) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=code)


async def body(request: Request) -> dict:
    try:
        return await request.json()
    except ValueError:
        return {}


def guarded(fn):
    """Route wrapper: board errors become 400 with the message."""
    async def wrapper(request: Request):
        try:
            return await fn(request)
        except (SceneError, ValueError, KeyError) as e:
            return err(str(e))
    return wrapper


def unlocked(fn):
    """Route wrapper: refused while a live Lichess game is on (analysis, engine, Claude — coach/lichess.py)."""
    async def wrapper(request: Request):
        if S.lock:
            return err(S.lock, 423)
        return await fn(request)
    return wrapper


# ---------------- basics ----------------
async def index(_: Request):
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


async def ping(_: Request):
    return JSONResponse({"ok": True, "clients": len(S.clients)})


async def state(_: Request):
    return JSONResponse({
        "settings": S.settings, "study": S.study, "progress": S.progress,
        "chats": CHATS.listing(), "models": MODELS, "efforts": EFFORTS,
        "jobs": [j.public() for j in jobs.JOBS.values()], "job_kinds": jobs.KINDS,
        "live": live.L.public(), "rep": repertoire.REP.public(),
    })


async def puzzles(_: Request):
    return Response(S.puzzles_raw, media_type="application/json", headers={"Cache-Control": "no-store"})


async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    S.clients.add(q)

    async def gen():
        try:
            yield {"data": json.dumps({"type": "hello"})}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=10)
                except TimeoutError:
                    continue
                yield {"data": json.dumps(ev, ensure_ascii=False)}
        finally:
            S.clients.discard(q)

    return EventSourceResponse(gen(), ping=15)


async def view(request: Request):
    prev = S.view.get("sceneId")
    S.view = await body(request)
    S.view["at"] = int(time.time() * 1000)
    CHATS.seen(S.view.get("chat"))
    # «Репертуар» is «Разбор» with the repertoire on; a board of «Игра» / «Задачи» keeps their name (app.js study.host)
    m = "rep" if S.view.get("rep") else S.view.get("host") or S.view.get("mode")
    if m in ("study", "puzzle", "play", "rep") and m != S.settings.get("mode"):
        S.settings["mode"] = m
        S.save_settings()
    if S.view.get("sceneId"):
        S.study["current"] = S.view["sceneId"]
        await board.note_view(prev, S.view["sceneId"])
    return JSONResponse({"ok": True})


async def put_progress(request: Request):
    pid = request.path_params["pid"]
    if pid not in S.puzzles:
        return err("unknown puzzle", 404)
    S.progress[pid] = await body(request)
    save_json(DATA / "progress.json", S.progress)
    return JSONResponse({"ok": True})


async def put_settings(request: Request):
    b = await body(request)
    S.settings.update(b)
    S.save_settings()
    return JSONResponse({"ok": True})


@unlocked
@guarded
async def explain_ep(request: Request):
    b = await body(request)
    p = S.puzzles.get(b.get("id"))
    if not p:
        return err("unknown puzzle", 404)
    uci = b.get("uci")
    if uci and uci not in p["moves"]:
        return err("move not in this puzzle")
    fn = (lambda: explain.explain_move(p, uci)) if uci else (lambda: explain.explain_best(p))
    return JSONResponse(await anyio.to_thread.run_sync(fn))


# ---------------- board operations ----------------
@guarded
async def op(request: Request):
    """Board operations for Claude Code outside the app (coach/mcp_server.py)."""
    return JSONResponse(await board.call_op(request.path_params["name"], await body(request)))


@unlocked
@guarded
async def ui_scene(request: Request):
    return JSONResponse(await board.op_show(await body(request)))


@unlocked
@guarded
async def ui_move(request: Request):
    return JSONResponse(await board.op_user_move(await body(request)))


@unlocked
@guarded
async def ui_edit(request: Request):
    return JSONResponse(await board.op_edit(await body(request)))


@unlocked
@guarded
async def ui_add(request: Request):
    b = await body(request)
    b["by"] = "user"
    return JSONResponse(await board.op_add_line(b))


@guarded
async def ui_delete_scene(request: Request):
    return JSONResponse(await board.op_delete_scene(await body(request)))


@unlocked
@guarded
async def ui_analyse(request: Request):
    b = await body(request)
    b["ui"] = True
    return JSONResponse(await board.op_analyse(b))


@unlocked
@guarded
async def summary(_: Request):
    return JSONResponse(board.op_summary({}))


async def reload_ui(_: Request):
    """Dev hook: make every open window reload the UI (after editing coach/web)."""
    await broadcast({"type": "reload"})
    return JSONResponse({"ok": True})


DEBUG = os.environ.get("COACH_DEBUG") == "1"
_debug_results: dict[str, object] = {}


async def debug_eval(request: Request):
    """Test harness only: run JS in the open windows; the result comes back to /api/debug/result."""
    if not DEBUG:
        return err("debug is off", 404)
    b = await body(request)
    _debug_results.pop(b["id"], None)
    await broadcast({"type": "eval", "id": b["id"], "js": b["js"]})
    for _ in range(200):
        if b["id"] in _debug_results:
            return JSONResponse({"result": _debug_results.pop(b["id"])})
        await asyncio.sleep(0.1)
    return err("no answer from the window", 504)


async def debug_result(request: Request):
    if not DEBUG:
        return err("debug is off", 404)
    b = await body(request)
    _debug_results[b["id"]] = b.get("result")
    return JSONResponse({"ok": True})


async def play(request: Request):
    """Test hook: make a move on the UI board as if the user played it ({"move": "Nf3"})."""
    await broadcast({"type": "play", "move": (await body(request)).get("move", "")})
    return JSONResponse({"ok": True})


# ---------------- chats ----------------
@guarded
async def chat_new(request: Request):
    """A new chat; with `scene`, the chat of that board: its own chat if it has one, else a new chat it joins.
    With `for` (a key of S.settings["chat_for"], see coach/chat.py): the chat of that thing — a puzzle, a game… —
    if it has one (a board of it joins that chat), else a new chat bound to it."""
    b = await body(request)
    sc = board.find_scene(b.get("scene"))
    if b.get("scene") and sc is None:
        return err("no such board", 404)
    if sc and sc.get("chat") in CHATS.chats:
        return JSONResponse(CHATS.chats[sc["chat"]].info())
    key = b.get("for") or None
    chat = None if b.get("fresh") else CHATS.chat_for(key)  # fresh: «Новый разговор», the old chat stays in the list
    if chat is None:
        chat = await CHATS.create(b.get("model"), b.get("effort"), about=key)
        if key:
            await CHATS.bind_for(key, chat.id)
    if sc:
        await board.bind_chat(sc, chat.id)
    return JSONResponse(chat.info())


async def chat_get(request: Request):
    chat = CHATS.chats.get(request.path_params["cid"])
    if not chat:
        return err("no such chat", 404)
    return JSONResponse({"meta": chat.info(), "entries": chat.entries})


@guarded
async def chat_send(request: Request):
    b = await body(request)
    text = (b.get("text") or "").strip()
    if not text:
        return err("empty message")
    sup = b.get("supersedes")
    await CHATS.send(request.path_params["cid"], text, key=b.get("key") or None,
                     supersedes=[str(k) for k in sup] if isinstance(sup, list) else None)
    return JSONResponse({"ok": True})


@guarded
async def chat_config(request: Request):
    b = await body(request)
    await CHATS.configure(request.path_params["cid"], b.get("model"), b.get("effort"))
    return JSONResponse({"ok": True})


@guarded
async def chat_stop(request: Request):
    await CHATS.interrupt(request.path_params["cid"])
    return JSONResponse({"ok": True})


@guarded
async def chat_perm(request: Request):
    b = await body(request)
    await CHATS.answer(request.path_params["cid"], b["req"], bool(b.get("allow")), bool(b.get("always")))
    return JSONResponse({"ok": True})


@guarded
async def chat_delete(request: Request):
    await CHATS.delete(request.path_params["cid"])
    return JSONResponse({"ok": True})


@guarded
async def chat_clear(request: Request):
    return JSONResponse({"cleared": await CHATS.clear(request.path_params["cid"])})


async def chat_bind(request: Request):
    """An older chat about a puzzle, a game… chosen again (in «Все чаты»): it is that thing's chat again."""
    chat = CHATS.chats.get(request.path_params["cid"])
    if not chat:
        return err("no such chat", 404)
    if chat.about:
        await CHATS.bind_for(chat.about, chat.id)
    return JSONResponse({"ok": True})


async def chat_close(request: Request):
    await CHATS.close(request.path_params["cid"])
    return JSONResponse({"ok": True})


# ---------------- Lichess: the login (coach/lichess.py) and live games (coach/live.py) ----------------
CALLBACK = f"http://127.0.0.1:{PORT}/api/lichess/callback"
ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}", *([lan.origin()] if lan.enabled() else [])}


def li_route(fn):
    """POSTs that act on the user's Lichess account: JSON from the app's own window only — a web page in
    the browser cannot send JSON here without a CORS preflight, which this server never answers."""
    async def wrapper(request: Request):
        origin = request.headers.get("origin")
        if origin and origin not in ORIGINS:
            return err("forbidden origin", 403)
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            return err("expected application/json", 415)
        try:
            return await fn(request, await body(request))
        except (lichess.LichessError, live.LiveError) as e:
            return err(str(e))
        except httpx.HTTPError as e:
            return err(f"нет связи с Lichess ({type(e).__name__})", 502)
        except (KeyError, TypeError, ValueError) as e:
            return err(f"bad request: {e}")
    return wrapper


def page(title: str, text: str) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'><title>Шахматный тренер</title>"
        "<body style='font:16px -apple-system,system-ui;display:grid;place-items:center;height:90vh;margin:0'>"
        f"<div style='max-width:460px;text-align:center'><h2>{html.escape(title)}</h2><p>{html.escape(text)}</p></div>")


async def logged_in() -> None:
    """A new login: live games start following the account; every window learns about it."""
    await live.L.start()
    await live.L.emit()
    await broadcast({"type": "lichess", "account": lichess.ACCOUNT.public()})


async def li_state(_: Request):
    await live.L.start()  # e.g. after a login: follow the account's games
    return JSONResponse(live.L.public())


async def li_login(_: Request):
    """Opened in the user's browser: on to Lichess, which asks whether to let the app play and do puzzles."""
    return RedirectResponse(lichess.ACCOUNT.login_url(CALLBACK))


async def li_callback(request: Request):
    q = request.query_params
    if q.get("error"):
        return page("Lichess не подключён", "Доступ не разрешён. Можно попробовать ещё раз из приложения.")
    try:
        await lichess.ACCOUNT.finish_login(q.get("code", ""), q.get("state", ""))
    except (lichess.LichessError, httpx.HTTPError, KeyError, ValueError) as e:
        return page("Lichess не подключён", str(e) or type(e).__name__)
    await logged_in()
    return page(f"Lichess подключён: {lichess.ACCOUNT.user()}", "Вернись в «Шахматный тренер». Эту вкладку можно закрыть.")


@li_route
async def li_token(_: Request, b: dict):
    await lichess.ACCOUNT.set_token(b.get("token", ""))
    await logged_in()
    return JSONResponse(live.L.public())


@li_route
async def li_logout(_: Request, b: dict):
    if live.L.live():
        raise lichess.LichessError("сначала закончи партию")
    await live.L.cancel_seek(emit=False)
    await lichess.ACCOUNT.logout()
    await live.L.emit()
    await broadcast({"type": "lichess", "account": lichess.ACCOUNT.public()})
    return JSONResponse({"ok": True})


@li_route
async def li_seek(_: Request, b: dict):
    await live.L.start_seek(int(b["time"]), int(b["increment"]), bool(b.get("rated", True)))
    return JSONResponse({"ok": True})


@li_route
async def li_seek_cancel(_: Request, b: dict):
    await live.L.cancel_seek()
    return JSONResponse({"ok": True})


@li_route
async def li_ai(_: Request, b: dict):
    await live.L.play_ai(int(b["level"]), int(b["time"]), int(b["increment"]), b.get("color", "random"))
    return JSONResponse({"ok": True})


@li_route
async def li_move(_: Request, b: dict):
    await live.L.move(b["game"], b["uci"])
    return JSONResponse({"ok": True})


@li_route
async def li_action(_: Request, b: dict):
    await live.L.action(b["game"], b["action"])
    return JSONResponse({"ok": True})


# ---------------- game reviews and the user's game history (coach/review.py) ----------------
@unlocked
@guarded
async def history_ep(request: Request):
    q = request.query_params
    return JSONResponse(review.history(int(q.get("offset", 0)), min(int(q.get("limit", 30)), 100)))


@unlocked
@guarded
async def history_refresh(_: Request):
    await review.refresh()
    return JSONResponse({"ok": True})


@unlocked
@guarded
async def review_ep(request: Request):
    b = await body(request)
    return JSONResponse(await review.start(str(b.get("game", ""))))


# ---------------- jobs ----------------
@guarded
async def job_start(request: Request):
    b = await body(request)
    job = await jobs.start(b.get("kind", ""), b.get("chat"))
    return JSONResponse(job.public())


@guarded
async def job_stop(request: Request):
    await jobs.cancel(request.path_params["jid"])
    return JSONResponse({"ok": True})


# ---------------- Lichess puzzle ladder (coach/lichess_puzzles.py; login is coach/lichess.py) ----------------
_weak_cache: dict = {}


@guarded
@unlocked
async def lpuzzle_status(_: Request):
    return JSONResponse({**await LP.status(), "themes": THEME_RU})


@guarded
@unlocked
async def lpuzzle_weak(_: Request):
    _weak_cache["list"] = await weak_themes(list(S.puzzles.values()), S.progress)
    _weak_cache["at"] = time.time()
    return JSONResponse({"themes": _weak_cache["list"]})


@guarded
@unlocked
async def lpuzzle_next(request: Request):
    b = await body(request)
    angle, extra = b.get("angle") or "weak", {}
    if angle == "weak":
        angle, why_ = await pick_weak(LP, list(S.puzzles.values()), S.progress, _weak_cache)
        extra = {"weak": True, "why": why_}
    res = await LP.next_puzzle(b.get("difficulty") or "normal", angle)
    return JSONResponse({**res, "angle": angle, "angleName": THEME_RU.get(angle, angle), **extra})


@guarded
@unlocked
async def lpuzzle_solve(request: Request):
    b = await body(request)
    return JSONResponse(await LP.solve(b["id"], bool(b.get("win")), b.get("angle") or "mix"))


@guarded
@unlocked
async def lpuzzle_explain(request: Request):
    b = await body(request)
    return JSONResponse(await LP.explain(b["fen"], b["uci"], b["best"]))


@contextlib.asynccontextmanager
async def lifespan(_: Starlette):
    with contextlib.suppress(Exception):  # an old review board without its players only lacks the names
        review.backfill_players()
    with contextlib.suppress(Exception):  # an old board without its moves before only keeps them unclickable
        board.backfill_history()
    with contextlib.suppress(Exception):  # an old chat without `about` only keeps its boards in «Разбор»
        CHATS.settle_about()
    await live.L.start()
    repertoire.REP.start()
    CHATS.start()
    yield
    await live.L.close()
    for chat in list(CHATS.chats.values()):
        await CHATS._stop_worker(chat)
    ENGINE.close()
    repertoire.PLAY.close()


app = Starlette(
    routes=[
        Route("/", index),
        Route("/api/ping", ping),
        Route("/api/state", state),
        Route("/api/puzzles", puzzles),
        Route("/api/events", events),
        Route("/api/view", view, methods=["POST"]),
        Route("/api/progress/{pid}", put_progress, methods=["PUT"]),
        Route("/api/settings", put_settings, methods=["PUT"]),
        Route("/api/explain", explain_ep, methods=["POST"]),
        Route("/api/op/{name}", op, methods=["POST"]),
        Route("/api/summary", summary),
        Route("/api/scene", ui_scene, methods=["POST"]),
        Route("/api/scene/move", ui_move, methods=["POST"]),
        Route("/api/scene/edit", ui_edit, methods=["POST"]),
        Route("/api/scene/add", ui_add, methods=["POST"]),
        Route("/api/scene/delete", ui_delete_scene, methods=["POST"]),
        Route("/api/analyse", ui_analyse, methods=["POST"]),
        Route("/api/play", play, methods=["POST"]),
        Route("/api/reload", reload_ui, methods=["POST"]),
        Route("/api/debug/eval", debug_eval, methods=["POST"]),
        Route("/api/debug/result", debug_result, methods=["POST"]),
        Route("/api/chat", chat_new, methods=["POST"]),
        Route("/api/chat/{cid}", chat_get),
        Route("/api/chat/{cid}/send", chat_send, methods=["POST"]),
        Route("/api/chat/{cid}/config", chat_config, methods=["POST"]),
        Route("/api/chat/{cid}/stop", chat_stop, methods=["POST"]),
        Route("/api/chat/{cid}/permission", chat_perm, methods=["POST"]),
        Route("/api/chat/{cid}/delete", chat_delete, methods=["POST"]),
        Route("/api/chat/{cid}/close", chat_close, methods=["POST"]),
        Route("/api/chat/{cid}/bind", chat_bind, methods=["POST"]),
        Route("/api/chat/{cid}/clear", chat_clear, methods=["POST"]),
        Route("/api/lichess", li_state),
        Route("/api/lichess/login", li_login),
        Route("/api/lichess/callback", li_callback),
        Route("/api/lichess/token", li_token, methods=["POST"]),
        Route("/api/lichess/logout", li_logout, methods=["POST"]),
        Route("/api/lichess/seek", li_seek, methods=["POST"]),
        Route("/api/lichess/seek/cancel", li_seek_cancel, methods=["POST"]),
        Route("/api/lichess/ai", li_ai, methods=["POST"]),
        Route("/api/lichess/move", li_move, methods=["POST"]),
        Route("/api/lichess/action", li_action, methods=["POST"]),
        Route("/api/history", history_ep),
        Route("/api/history/refresh", history_refresh, methods=["POST"]),
        Route("/api/review", review_ep, methods=["POST"]),
        Route("/api/job", job_start, methods=["POST"]),
        Route("/api/lpuzzle/status", lpuzzle_status),
        Route("/api/lpuzzle/weak", lpuzzle_weak),
        Route("/api/lpuzzle/next", lpuzzle_next, methods=["POST"]),
        Route("/api/lpuzzle/solve", lpuzzle_solve, methods=["POST"]),
        Route("/api/lpuzzle/explain", lpuzzle_explain, methods=["POST"]),
        Route("/api/job/{jid}/stop", job_stop, methods=["POST"]),
        *repertoire.ROUTES,
        Mount("/static", StaticFiles(directory=WEB), name="static"),
    ],
    lifespan=lifespan,
)
