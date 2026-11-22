"""Where the user's own data lives, and the settings that differ between people.

Personal data is kept outside the sources, in ~/Library/Application Support/ChessCoach, so every copy of the
repository (each git worktree) sees the same games, chats and Lichess login:
  config.toml   settings (a copy of config.example.toml)
  app/          the app's own state: Lichess login, chats, diagrams, puzzle progress, window settings
  lichess/      games.ndjson and profile.json (scripts/fetch_games.py)
  analysis/     moves.jsonl (scripts/analyze.py)
  puzzles.json  puzzles from the user's mistakes (scripts/make_puzzles.py)
COACH_HOME moves all of it; COACH_DATA moves only app/ (a test server with its own state and the real games).

Every key of config.toml is optional and empty by default:
  lichess_user — whose games to download and analyse; empty = the account signed in to Lichess in the app
  stockfish    — path to Stockfish; empty = found on PATH or in Homebrew's usual places
  about        — a note about the player for Claude in the chat

Kept free of heavy imports: scripts/*.py import it too.
"""

import json
import os
import shutil
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path(os.environ.get("COACH_HOME") or "~/Library/Application Support/ChessCoach").expanduser()
DATA = Path(os.environ.get("COACH_DATA") or HOME / "app")
FILE = HOME / "config.toml"
GAMES = HOME / "lichess" / "games.ndjson"
PROFILE = HOME / "lichess" / "profile.json"
MOVES = HOME / "analysis" / "moves.jsonl"
PUZZLES = HOME / "puzzles.json"
NO_USER = (
    "Не знаю, чьи партии брать: войди в Lichess в приложении (вкладка «Игра») "
    "или впиши свой ник в lichess_user в config.toml."
)


def load() -> dict:
    try:
        return tomllib.loads(FILE.read_text())
    except FileNotFoundError:
        return {}


def _get(key: str) -> str:
    return str(load().get(key) or "").strip()


def lichess_user() -> str:
    """Lichess id (lowercase) of the player: config.toml, else the app's Lichess login, else ""."""
    user = _get("lichess_user")
    if not user:
        try:  # the login coach/lichess.py keeps; read directly, so scripts need no app imports
            user = json.loads((DATA / "lichess.json").read_text()).get("user") or ""
        except OSError, ValueError:
            user = ""
    return user.strip().lower()


def stockfish() -> str:
    """Path to the Stockfish binary. The app started from Finder has a short PATH, hence the fixed places."""
    if path := _get("stockfish"):
        return os.path.expanduser(path)
    for path in (
        shutil.which("stockfish"),
        "/opt/homebrew/bin/stockfish",
        "/usr/local/bin/stockfish",
    ):
        if path and os.path.exists(path):
            return path
    return "stockfish"


def about() -> str:
    return _get("about")
