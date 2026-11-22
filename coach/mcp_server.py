"""MCP server for Claude Code outside the app (terminal / editor): the same board tools the in-app chat has.

Each tool forwards to POST /api/op/<name> of the app's local server (127.0.0.1:8737);
if the app window is not open, the tool opens it first. Register with:
  claude mcp add --scope local chess-board -e PYTHONPATH=<project> -- <project>/.venv/bin/python -m coach.mcp_server
"""

import asyncio
import json
import subprocess
from pathlib import Path

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

BASE = "http://127.0.0.1:8737"
APP = Path.home() / "Applications" / "Шахматный тренер.app"

mcp = MCPServer(
    "chess-board",
    instructions=(
        "Drive the board of the user's desktop app «Шахматный тренер» (Lichess-style move tree, Stockfish, puzzles). "
        "Read board_state first when the user refers to the position they see; check lines with analyse before claiming them."
    ),
)


async def ensure_app() -> None:
    async with httpx.AsyncClient(timeout=2) as c:
        for attempt in range(81):
            try:
                if (await c.get(f"{BASE}/api/ping")).json().get("clients"):
                    return
            except (httpx.HTTPError, ValueError):
                pass
            if attempt == 0:
                if not APP.exists():
                    raise ToolError(f"App not installed at {APP}; build it with mac/build.sh")
                subprocess.Popen(["open", "-g", str(APP)])
            await asyncio.sleep(0.25)
    raise ToolError("The chess app did not open its window in 20 s")


async def op(name: str, args: dict) -> str:
    await ensure_app()
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(f"{BASE}/api/op/{name}", json={k: v for k, v in args.items() if v is not None})
    data = r.json()
    if r.status_code >= 400:
        raise ToolError(data.get("error") or str(data))
    return json.dumps(data, ensure_ascii=False, indent=1)


AT = "Node: 'start', 'current' (what the user sees), node id like 'n12', or moves from the diagram start ('25.a4 Ng2')."
SHAPES = "Shapes: 'e2e4' (green arrow), 'e2e4:red', 'f7:yellow' (circle), 'f7:red:!' (label)."


@mcp.tool()
async def board_state() -> str:
    """What the user sees: mode, board FEN + diagram, the study tree (PGN with [nX] ids, ·user = their moves) and current node,
    or the puzzle with engine data and their tries."""
    return await op("board_state", {})


@mcp.tool(description=f"New diagram (study mode). lines: [{{moves, title, comment, shapes, at}}]; first = main line. {SHAPES}")
async def show(title: str, position: str = "start", lines: list[dict] | None = None, comment: str = "",
               shapes: list[str] | None = None, orientation: str | None = None, goto: str | None = None) -> str:
    return await op("show", {"title": title, "position": position, "lines": lines or [], "comment": comment,
                             "shapes": shapes or [], "orientation": orientation, "goto": goto})


@mcp.tool(description=f"Add moves to the tree from `at` (default start); new moves become a variation. {AT}")
async def add_line(moves: str | list, at: str | None = None, title: str = "", comment: str = "",
                   shapes: list[str] | None = None) -> str:
    return await op("add_line", {"moves": moves, "at": at, "title": title, "comment": comment, "shapes": shapes})


@mcp.tool(description=f"Comment / shapes / glyph on a node (default: current) and show it. {AT} {SHAPES}")
async def annotate(at: str | None = "current", comment: str | None = None, shapes: list[str] | None = None,
                   glyph: str | None = None, append: bool = False, title: str | None = None) -> str:
    return await op("annotate", {"at": at, "comment": comment, "shapes": shapes, "glyph": glyph, "append": append, "title": title})


@mcp.tool(description=f"Move the user's board to a node. {AT}")
async def goto(at: str = "start", scene: str | None = None) -> str:
    return await op("goto", {"at": at, "scene": scene})


@mcp.tool(description=f"'promote' the line through `at` to main line, or 'delete' it. {AT}")
async def edit(action: str, at: str = "current") -> str:
    return await op("edit", {"action": action, "at": at})


@mcp.tool()
async def analyse(position: str = "current", lines: int = 3, seconds: float = 2.0, threat: bool = False) -> str:
    """Stockfish top lines (eval from the side to move, win %, SAN). threat=True adds the opponent's null-move threat."""
    return await op("analyse", {"position": position, "lines": lines, "seconds": seconds, "threat": threat})


@mcp.tool()
async def puzzles(action: str = "stats", id: str | None = None) -> str:
    """Puzzle trainer: 'stats', 'failing', 'open' (id), 'resume'."""
    return await op("puzzles", {"action": action, "id": id})


if __name__ == "__main__":
    mcp.run()
