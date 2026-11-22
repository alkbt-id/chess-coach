"""python -m coach — run the app's local server (the desktop window starts it by itself).

A test server next to the user's real app, with its own data folder:
    python -m coach --home <test folder> --port 8738
"""

import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m coach", description="Локальный сервер «Шахматного тренера».")
    parser.add_argument("--home", help="папка данных вместо ~/Library/Application Support/ChessCoach (как COACH_HOME)")
    parser.add_argument("--port", type=int, help="порт вместо 8737 (как COACH_PORT)")
    args = parser.parse_args()
    # Through the environment, so the background jobs (scripts/*.py) and the chat's Claude Code get the same folder.
    if args.home:
        os.environ["COACH_HOME"] = os.path.abspath(os.path.expanduser(args.home))
    if args.port:
        os.environ["COACH_PORT"] = str(args.port)

    import uvicorn  # imported only now: coach.config and coach.server read the environment on import

    from .server import PORT, app

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
