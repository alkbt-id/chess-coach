"""The app's one Lichess login, shared by every Lichess feature.

Sign-in is OAuth with PKCE in the user's own browser (Lichess needs no app registration); a personal
token can be pasted instead. The token lives in app/lichess.json of the data folder (mode 600, coach/config.py) and is never sent to
the window or to Claude.

Scopes: board:play (live games, coach/live.py) and puzzle:read + puzzle:write (the rated puzzle
ladder, coach/lichess_puzzles.py). Other modules call `auth_headers()` for the request header.
"""

import base64
import contextlib
import hashlib
import json
import os
import re
import secrets
import time
from urllib.parse import urlencode

import httpx

from .board import DATA, load_json

API = os.environ.get("COACH_LICHESS_URL", "https://lichess.org").rstrip("/")  # a fake server in tests
CLIENT_ID = "chess-coach-local"
SCOPES = ("board:play", "puzzle:read", "puzzle:write")
TOKEN_FILE = DATA / "lichess.json"
HEADERS = {"User-Agent": "chess-coach-local/0.1"}


class LichessError(ValueError):
    pass


def why(r: httpx.Response) -> str:
    """Lichess's error message from a failed response."""
    try:
        d = r.json()
    except ValueError:
        return f"Lichess ответил {r.status_code}"
    e = d.get("error") or d.get("error_description") if isinstance(d, dict) else None
    if isinstance(e, dict):  # form errors: {"field": ["message"]}
        e = "; ".join(f"{k}: {', '.join(v) if isinstance(v, list) else v}" for k, v in e.items())
    return f"Lichess: {e or r.status_code}"


class Account:
    def __init__(self) -> None:
        self.auth: dict = load_json(TOKEN_FILE, {})  # {token, user, scopes: [..], since}
        self.oauth: dict[str, tuple[str, str, float]] = {}  # state -> (code verifier, redirect uri, time)

    def token(self) -> str | None:
        return self.auth.get("token")

    def user(self) -> str | None:
        return self.auth.get("user")

    def has(self, scope: str) -> bool:
        return scope in (self.auth.get("scopes") or [])

    def public(self) -> dict:
        return {"connected": bool(self.token()), "user": self.user(), "scopes": self.auth.get("scopes") or []}

    def _save(self) -> None:
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = TOKEN_FILE.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self.auth, f)
        os.replace(tmp, TOKEN_FILE)

    def forget(self) -> None:
        """The token stopped working (revoked on lichess.org): drop it."""
        self.auth = {}
        TOKEN_FILE.unlink(missing_ok=True)

    # ---------------- sign-in ----------------
    def login_url(self, redirect_uri: str) -> str:
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(16)
        now = time.time()
        self.oauth = {k: v for k, v in self.oauth.items() if now - v[2] < 900}
        self.oauth[state] = (verifier, redirect_uri, now)
        q = {"response_type": "code", "client_id": CLIENT_ID, "redirect_uri": redirect_uri, "scope": " ".join(SCOPES),
             "code_challenge_method": "S256", "code_challenge": challenge, "state": state}
        return f"{API}/oauth?{urlencode(q)}"

    async def finish_login(self, code: str, state: str) -> None:
        entry = self.oauth.pop(state, None)
        if not entry or not code:
            raise LichessError("ссылка входа устарела — нажми «Подключить Lichess» в приложении ещё раз")
        verifier, redirect_uri, _ = entry
        async with httpx.AsyncClient(base_url=API, headers=HEADERS, timeout=20) as c:
            r = await c.post("/api/token", data={"grant_type": "authorization_code", "code": code, "code_verifier": verifier,
                                                 "redirect_uri": redirect_uri, "client_id": CLIENT_ID})
        if r.status_code != 200:
            raise LichessError(why(r))
        await self.set_token(r.json()["access_token"])

    async def set_token(self, tok: str) -> None:
        """Check a token (OAuth result or a pasted personal token) and keep it with its user and scopes."""
        tok = (tok or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{10,}", tok):
            raise LichessError("это не похоже на токен Lichess (он начинается с lip_)")
        async with httpx.AsyncClient(base_url=API, headers=HEADERS, timeout=20) as c:
            r = await c.post("/api/token/test", content=tok, headers={"Content-Type": "text/plain"})
            info = r.json().get(tok) if r.status_code == 200 else None
            if not info:
                raise LichessError("Lichess не принял этот токен")
            acc = await c.get("/api/account", headers={"Authorization": f"Bearer {tok}"})
        if acc.status_code != 200:
            raise LichessError(why(acc))
        scopes = [s for s in (info.get("scopes") or "").split(",") if s]
        self.auth = {"token": tok, "user": acc.json().get("username") or info.get("userId"), "scopes": scopes, "since": int(time.time())}
        self._save()

    async def logout(self) -> None:
        tok = self.token()
        if tok:
            with contextlib.suppress(httpx.HTTPError):
                async with httpx.AsyncClient(base_url=API, headers=HEADERS, timeout=15) as c:
                    await c.delete("/api/token", headers={"Authorization": f"Bearer {tok}"})  # revoke on Lichess
        self.forget()


ACCOUNT = Account()


def token() -> str | None:
    return ACCOUNT.token()


def auth_headers() -> dict | None:
    """{"Authorization": "Bearer …"} for the user's Lichess login, or None when not connected."""
    tok = ACCOUNT.token()
    return {"Authorization": f"Bearer {tok}"} if tok else None
