"""Download the user's games played since the last one in data/lichess/games.ndjson
(Lichess public API, no token) and refresh the profile.

Output: appends to data/lichess/games.ndjson, rewrites data/lichess/profile.json.
"""

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from coach.config import NO_USER, lichess_user

GAMES = ROOT / "data/lichess/games.ndjson"
PROFILE = ROOT / "data/lichess/profile.json"
USER = lichess_user() or sys.exit(NO_USER)
API = "https://lichess.org/api"
HEADERS = {"User-Agent": "chess-coach-local/0.1"}


def get(url: str, accept: str) -> bytes:
    req = urllib.request.Request(url, headers={**HEADERS, "Accept": accept})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main():
    known = {}
    if GAMES.exists():
        for line in GAMES.open():
            g = json.loads(line)
            known[g["id"]] = g["createdAt"]
    since = max(known.values()) + 1 if known else 0
    print(f"known games: {len(known)}; fetching since {since}", file=sys.stderr, flush=True)
    url = (f"{API}/games/user/{USER}?since={since}&moves=true&opening=true&evals=true"
           "&clocks=true&accuracy=true&pgnInJson=true")
    new = [json.loads(l) for l in get(url, "application/x-ndjson").decode().splitlines() if l.strip()]
    new = [g for g in new if g["id"] not in known]
    with GAMES.open("a") as f:
        for g in sorted(new, key=lambda g: g["createdAt"]):
            f.write(json.dumps(g, ensure_ascii=False) + "\n")
    PROFILE.write_bytes(get(f"{API}/user/{USER}", "application/json"))
    prof = json.loads(PROFILE.read_text())
    rapid = prof.get("perfs", {}).get("rapid", {})
    rated = sum(1 for g in new if g.get("rated") and g.get("variant") == "standard")
    print(f"done: {len(new)} new games ({rated} rated standard); rapid rating {rapid.get('rating')}")


if __name__ == "__main__":
    main()
