"""python -m coach — run the app's local server (the desktop window starts it by itself)."""

import uvicorn

from .server import PORT, app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
