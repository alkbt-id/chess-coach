"""The app on an iPad (or any device at home): a second listener on the home network, over https, with a key.

The window on the Mac keeps using http://127.0.0.1:8737. When the data folder has tls/cert.pem, the same
server also listens on all interfaces at https://<mac>.local:8443 (COACH_LAN_PORT). Every request there must
carry the key: the link https://<mac>.local:8443/?key=<key> sets a cookie, later requests send the cookie.
The certificate comes from mkcert: its root (rootCA.pem in `mkcert -CAROOT`) is installed on the iPad once.

Setup, once:  uv run python -m coach.lan   (makes the certificate and the key, prints the link)
Turning it off: delete tls/ in the data folder and restart the app.
"""

import contextlib
import hmac
import logging
import os
import secrets
import shutil
import socket
import subprocess
import sys

import uvicorn
from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse

from .config import DATA, HOME

TLS = HOME / "tls"
CERT = TLS / "cert.pem"
KEY_PEM = TLS / "key.pem"
KEY_FILE = DATA / "lan_key"
PORT = int(os.environ.get("COACH_LAN_PORT", "8443"))
COOKIE = "coach_key"
log = logging.getLogger("coach.lan")


def host() -> str:
    """The Mac's name on the home network (Bonjour), e.g. alkbtmac.local."""
    # full path: the app started from Finder gives the server a short PATH without /usr/sbin
    try:
        name = subprocess.run(["/usr/sbin/scutil", "--get", "LocalHostName"], capture_output=True, text=True,
                              check=False).stdout.strip()
    except OSError:
        name = ""
    return f"{name or socket.gethostname().removesuffix('.local')}.local"


def enabled() -> bool:
    return CERT.exists() and KEY_PEM.exists()


def origin() -> str:
    return f"https://{host()}:{PORT}"


def key() -> str:
    """The access key, made on first use (mode 600, next to the app's other secrets)."""
    if not KEY_FILE.exists():
        KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        KEY_FILE.write_text(secrets.token_urlsafe(24))
        KEY_FILE.chmod(0o600)
    return KEY_FILE.read_text().strip()


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


class Gate:
    """ASGI wrapper for the home-network listener: only requests with the key get through.

    ?key=<key> on any page sets the cookie on that response (no redirect, so a Home Screen icon made from
    the link keeps working: it has its own cookie jar); after that the cookie is enough."""

    def __init__(self, app, secret: str):
        self.app = app
        self.secret = secret

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        conn = HTTPConnection(scope)
        if _same(conn.cookies.get(COOKIE, ""), self.secret):
            return await self.app(scope, receive, send)
        if scope["type"] == "http" and _same(conn.query_params.get("key", ""), self.secret):
            cookie = f"{COOKIE}={self.secret}; Max-Age=315360000; Path=/; Secure; HttpOnly; SameSite=Lax"

            async def send_with_cookie(message):
                if message["type"] == "http.response.start":
                    message = {**message, "headers": [*message.get("headers", []), (b"set-cookie", cookie.encode())]}
                await send(message)

            return await self.app(scope, receive, send_with_cookie)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        page = HTMLResponse(
            "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
            "<title>Шахматный тренер</title><body style='font:17px -apple-system,system-ui;padding:40px 20px'>"
            "<h2>Нужен ключ</h2><p>Открой ссылку с ключом: её печатает <code>uv run python -m coach.lan</code> на Mac.</p>",
            status_code=401)
        return await page(scope, receive, send)


class _Follower(uvicorn.Server):
    """Leaves the signals to the main 127.0.0.1 server, which stops this one when it stops."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


async def serve(app) -> None:
    """The home-network listener until it is told to stop; a port that is taken only logs a warning."""
    server = _Follower(uvicorn.Config(
        Gate(app, key()), host="0.0.0.0", port=PORT, ssl_certfile=str(CERT), ssl_keyfile=str(KEY_PEM),
        lifespan="off", log_level="warning"))
    try:
        await server.serve()
    except SystemExit:  # uvicorn exits when it cannot bind; the app on the Mac must keep running
        log.warning("iPad: port %s is taken, the home-network listener is off", PORT)



def _mkcert() -> str:
    path = shutil.which("mkcert") or "/opt/homebrew/bin/mkcert"
    if not os.path.exists(path):
        sys.exit("Нет mkcert. Поставь: brew install mkcert")
    return path


def setup() -> None:
    """Certificate for this Mac's name, the key, and the link to open on the iPad."""
    mkcert = _mkcert()
    name = host()
    TLS.mkdir(parents=True, exist_ok=True)
    subprocess.run([mkcert, "-cert-file", str(CERT), "-key-file", str(KEY_PEM), name], check=True)
    KEY_PEM.chmod(0o600)
    ca = subprocess.run([mkcert, "-CAROOT"], capture_output=True, text=True, check=True).stdout.strip()
    link = f"https://{name}:{PORT}/?key={key()}"
    subprocess.run(["pbcopy"], input=link, text=True, check=False)
    print(f"""
Готово. Дальше:
1. Перезапусти «Шахматного тренера» на Mac.
2. Корневой сертификат на iPad: {ca}/rootCA.pem
   Отправь его на iPad через AirDrop, затем «Настройки → Профиль загружен → Установить»
   и «Настройки → Основные → Об этом устройстве → Доверие сертификатам» → включи mkcert.
3. Ссылка с ключом скопирована в буфер (на iPad она вставляется через общий буфер обмена):
   {link}
""")


if __name__ == "__main__":
    setup()
