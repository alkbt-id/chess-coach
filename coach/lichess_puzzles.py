"""Rated Lichess puzzle ladder through the Lichess API, picked by the user's weaknesses.

The Lichess login is shared with the live-games feature: coach/lichess.py owns it (token, scopes,
login/logout routes). This module only uses its auth headers; on a 401 it tells that module to forget the token.
Without a login puzzles still come (anonymously, around 1500) but results are not rated.
"""

import random

import anyio
import chess
import httpx

from . import explain
from .engine import ENGINE
from .lichess import ACCOUNT, API, HEADERS, LichessError, auth_headers, why

DIFFICULTIES = ("easiest", "easier", "normal", "harder", "hardest")


def _headers() -> dict:
    return {**HEADERS, **(auth_headers() or {})}


class LPuzzles:
    def __init__(self) -> None:
        self.queue: list[dict] = []
        self.queue_key: tuple | None = None
        self.glicko: dict | None = None
        self.weak_pick: dict = {"theme": None, "left": 0, "why": ""}

    def _expired(self, r: httpx.Response) -> None:
        if r.status_code == 401:
            ACCOUNT.forget()
            raise LichessError("вход в Lichess больше не действует — подключи заново")

    async def status(self) -> dict:
        acc = ACCOUNT.public()
        if acc.get("connected") and self.glicko is None:
            try:
                async with httpx.AsyncClient(timeout=20, headers=_headers()) as c:
                    r = await c.get(f"{API}/api/account")
                self._expired(r)
                pr = (r.json().get("perfs") or {}).get("puzzle") or {}
                if pr:
                    self.glicko = {"rating": pr.get("rating"), "deviation": pr.get("rd"), "provisional": pr.get("prov", False)}
            except httpx.HTTPError:
                pass
        return {"account": acc, "rated": ACCOUNT.has("puzzle:write"), "glicko": self.glicko}

    # ---------------- puzzles ----------------
    @staticmethod
    def convert(item: dict) -> dict:
        """Lichess PuzzleAndGame -> what the board needs: the position after the game's last move,
        that move (the opponent's), and the solution as UCI + SAN (player, reply, player, …)."""
        game, pz = item["game"], item["puzzle"]
        board = chess.Board()
        last = None
        for san in game["pgn"].split():
            mv = board.parse_san(san)
            last = mv.uci()
            board.push(mv)
        fen = board.fen()
        sans = []
        b = board.copy()
        for u in pz["solution"]:
            mv = chess.Move.from_uci(u)
            sans.append(b.san(mv))
            b.push(mv)
        players = {p.get("color"): p for p in game.get("players", [])}
        color = "white" if board.turn == chess.WHITE else "black"
        return {
            "id": pz["id"], "rating": pz.get("rating"), "plays": pz.get("plays"), "themes": pz.get("themes", []),
            "fen": fen, "color": color, "last": last, "lastSan": game["pgn"].split()[-1] if game.get("pgn") else None,
            "solution": pz["solution"], "solutionSan": sans,
            "game": game.get("id"), "ply": pz.get("initialPly"),
            "opponent": (players.get("black" if color == "white" else "white") or {}).get("name"),
        }

    async def next_puzzle(self, difficulty: str = "normal", angle: str = "mix") -> dict:
        difficulty = difficulty if difficulty in DIFFICULTIES else "normal"
        key = (difficulty, angle, bool(auth_headers()))
        if key != self.queue_key:
            self.queue, self.queue_key = [], key
        if not self.queue:
            async with httpx.AsyncClient(timeout=30, headers=_headers()) as c:
                r = await c.get(f"{API}/api/puzzle/batch/{angle}", params={"nb": 10, "difficulty": difficulty})
            self._expired(r)
            if r.status_code != 200:
                raise LichessError(why(r))
            data = r.json()
            if data.get("glicko") and auth_headers():
                self.glicko = data["glicko"]
            self.queue = [self.convert(x) for x in data.get("puzzles", [])]
            if not self.queue:
                raise LichessError("Lichess не прислал задач")
        return {"puzzle": self.queue.pop(0), "rated": ACCOUNT.has("puzzle:write"), "glicko": self.glicko}

    async def solve(self, pid: str, win: bool, angle: str = "mix") -> dict:
        if not ACCOUNT.has("puzzle:write"):
            return {"rated": False}
        async with httpx.AsyncClient(timeout=30, headers=_headers()) as c:
            r = await c.post(f"{API}/api/puzzle/batch/{angle}", json={"solutions": [{"id": pid, "win": win, "rated": True}]})
        self._expired(r)
        if r.status_code != 200:
            raise LichessError(why(r))
        data = r.json()
        before = (self.glicko or {}).get("rating")
        if data.get("glicko"):
            self.glicko = data["glicko"]
        diff = next((x.get("ratingDiff") for x in data.get("rounds", []) if x.get("id") == pid), None)
        return {"rated": True, "ratingDiff": diff, "before": before, "glicko": self.glicko}

    # ---------------- explanation of a wrong move (engine templates, as for own puzzles) ----------------
    @staticmethod
    def explain_free(fen: str, uci: str, best: str) -> dict:
        board = chess.Board(fen)
        moves = {}
        for u in dict.fromkeys([best, uci]):
            b = board.copy(stack=False)
            b.push(chess.Move.from_uci(u))
            if b.is_checkmate():
                moves[u] = [100.0, []]
                continue
            if b.is_game_over():
                moves[u] = [50.0, []]
                continue
            info = ENGINE.analyse(b, nodes=600_000)[0]
            moves[u] = [round(100 - info["win"], 1), [m.uci() for m in info["pv"][:8]]]
        p = {"fen": fen, "moves": moves, "best": best, "kind": "blunder", "lastSan": None}
        return explain.explain_move(p, uci)

    async def explain(self, fen: str, uci: str, best: str) -> dict:
        return await anyio.to_thread.run_sync(lambda: self.explain_free(fen, uci, best))


# ---------------- weaknesses: which Lichess themes to train ----------------
THEME_RU = {
    "mix": "Смесь", "fork": "Вилка", "pin": "Связка", "skewer": "Сквозной удар", "hangingPiece": "Висящая фигура",
    "defensiveMove": "Защитный ход", "discoveredAttack": "Вскрытое нападение", "doubleCheck": "Двойной шах",
    "mateIn1": "Мат в 1 ход", "mateIn2": "Мат в 2 хода", "mateIn3": "Мат в 3 хода", "mate": "Мат",
    "backRankMate": "Мат по последней горизонтали", "opening": "Дебют", "middlegame": "Миттельшпиль",
    "endgame": "Эндшпиль", "advantage": "Перевес", "crushing": "Разгром", "attraction": "Завлечение",
    "deflection": "Отвлечение", "sacrifice": "Жертва", "trappedPiece": "Пойманная фигура", "quietMove": "Тихий ход",
    "kingsideAttack": "Атака на короля", "exposedKing": "Открытый король", "intermezzo": "Промежуточный ход",
    "capturingDefender": "Уничтожение защиты", "clearance": "Освобождение линии", "interference": "Перекрытие",
    "xRayAttack": "Рентген", "zugzwang": "Цугцванг", "promotion": "Превращение", "short": "Короткая",
    "long": "Длинная", "veryLong": "Очень длинная", "oneMove": "В один ход", "rookEndgame": "Ладейный эндшпиль",
    "pawnEndgame": "Пешечный эндшпиль", "queenEndgame": "Ферзевый эндшпиль", "bishopEndgame": "Слоновый эндшпиль",
    "knightEndgame": "Коневой эндшпиль", "attackingF2F7": "Атака на f2/f7", "equality": "Уравнять игру",
    "master": "Партии мастеров", "smotheredMate": "Спёртый мат", "anastasiaMate": "Мат Анастасии",
    "arabianMate": "Арабский мат", "bodenMate": "Мат Бодена", "hookMate": "Мат крюком", "castling": "Рокировка",
    "enPassant": "Взятие на проходе", "underPromotion": "Слабое превращение", "advancedPawn": "Продвинутая пешка",
}
VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def _forks(board: chess.Board, sq: int, color: chess.Color) -> bool:
    """Does the piece on `sq` attack two valuable enemy pieces (or the king and one more)?"""
    hits = [t for t in board.attacks(sq)
            if (pc := board.piece_at(t)) and pc.color != color and (VAL[pc.piece_type] >= 3 or pc.piece_type == chess.KING)]
    return len(hits) >= 2


def classify_own(p: dict) -> str:
    """Which Lichess theme a mistake from the user's own game belongs to. Uses the engine lines already
    stored with the puzzle: only a real loss/gain of material counts as a hanging piece, not an exchange."""
    board = chess.Board(p["fen"])
    me = board.turn
    if p["kind"] == "blunder":
        line = [chess.Move.from_uci(u) for u in [p["played"], *p["moves"][p["played"]][1]]]
        plies = explain.walk(board, line, me)
        if any(x["mate"] for x in plies):
            return "kingsideAttack"  # walked into a mating attack
        lost, won, bal = explain.material(plies)
        if len(plies) >= 2:
            b = chess.Board(plies[1]["before"])
            b.push(chess.Move.from_uci(plies[1]["uci"]))
            if _forks(b, chess.parse_square(plies[1]["uci"][2:4]), not me):
                return "fork"  # the opponent's reply forks two pieces
        if bal <= -2 and plies[1:2] and plies[1]["captured"]:
            return "hangingPiece"  # the reply simply takes material that was left en prise
        return "defensiveMove"  # missed what the opponent was threatening
    line = [chess.Move.from_uci(u) for u in [p["best"], *p["moves"][p["best"]][1]]]
    plies = explain.walk(board, line, me)
    if any(x["mate"] for x in plies):
        return "kingsideAttack"
    lost, won, bal = explain.material(plies)
    if plies and plies[0]["captured"] and bal >= 2:
        return "hangingPiece"  # the opponent's blunder left something to take
    b = board.copy(stack=False)
    b.push(line[0])
    if _forks(b, line[0].to_square, me):
        return "fork"
    return "advantage"


def own_weaknesses(puzzles: list[dict], progress: dict) -> dict[str, dict]:
    """Themes of the user's game mistakes: how often, and how often the matching own puzzles fail."""
    out: dict[str, dict] = {}
    for p in puzzles:
        t = classify_own(p)
        e = out.setdefault(t, {"games": 0, "fail": 0, "tries": 0, "examples": []})
        e["games"] += 1
        if len(e["examples"]) < 8:
            e["examples"].append(p["id"])
        pr = progress.get(p["id"])
        if pr:
            e["tries"] += pr.get("ok", 0) + pr.get("fail", 0)
            e["fail"] += pr.get("fail", 0)
    if sum(p["phase"] == "opening" for p in puzzles) > len(puzzles) / 4:
        out.setdefault("opening", {"games": sum(p["phase"] == "opening" for p in puzzles), "fail": 0, "tries": 0,
                                   "examples": [p["id"] for p in puzzles if p["phase"] == "opening"][:8], "weight": 0.5})
    return out


async def weak_themes(puzzles: list[dict], progress: dict) -> list[dict]:
    """Themes to train, weakest first: Lichess dashboard (performance per theme vs. overall) plus game mistakes."""
    score: dict[str, float] = {}
    why: dict[str, list[str]] = {}
    dash = None
    if ACCOUNT.has("puzzle:read"):
        try:
            async with httpx.AsyncClient(timeout=30, headers=_headers()) as c:
                r = await c.get(f"{API}/api/puzzle/dashboard/90")
            if r.status_code == 200:
                dash = r.json()
        except httpx.HTTPError:
            pass
    if dash and dash.get("themes"):
        overall = dash.get("global", {}).get("performance") or 1500
        for key, t in dash["themes"].items():
            res = t.get("results", {})
            if res.get("nb", 0) < 4 or key in ("short", "long", "veryLong", "oneMove", "mix"):
                continue
            gap = overall - res.get("performance", overall)
            if gap > 0:
                score[key] = score.get(key, 0) + gap / 50
                why.setdefault(key, []).append(f"на Lichess решаешь их на {res.get('performance')} при общем уровне {overall}")
    own = own_weaknesses(puzzles, progress)
    total = sum(e["games"] for e in own.values()) or 1
    for key, e in own.items():
        share = e["games"] / total
        score[key] = score.get(key, 0) + e.get("weight", 1) * share * 10 + (e["fail"] / e["tries"] * 3 if e["tries"] else 0)
        n = e["games"]
        why.setdefault(key, []).append(f"в твоих партиях {n} {explain.plural(n, 'ошибка', 'ошибки', 'ошибок')} такого типа")
    ranked = sorted(score.items(), key=lambda kv: -kv[1])[:6]
    return [{"theme": k, "name": THEME_RU.get(k, k), "score": round(v, 1), "why": "; ".join(why.get(k, [])),
             "examples": own.get(k, {}).get("examples", [])} for k, v in ranked]


async def pick_weak(lp: "LPuzzles", puzzles: list[dict], progress: dict, cache: dict) -> tuple[str, str]:
    """A theme for the next puzzles: one of the 3 weakest, kept for 5 puzzles in a row."""
    import time
    if not cache.get("list") or time.time() - cache.get("at", 0) > 1800:
        cache["list"], cache["at"] = await weak_themes(puzzles, progress), time.time()
    if not lp.weak_pick["theme"] or lp.weak_pick["left"] <= 0:
        top = cache["list"][:3]
        if top:
            pick = random.choices(top, weights=[max(w["score"], 0.5) for w in top])[0]
            lp.weak_pick = {"theme": pick["theme"], "left": 5, "why": pick["why"]}
        else:
            lp.weak_pick = {"theme": "mix", "left": 5, "why": ""}
    lp.weak_pick["left"] -= 1
    return lp.weak_pick["theme"], lp.weak_pick["why"]


LP = LPuzzles()
