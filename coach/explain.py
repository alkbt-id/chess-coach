"""Plain-language reasons for puzzle moves, assembled from Stockfish lines by templates (no LLM).

explain_move(p, uci) — why a tried move is bad (or why it is fine).
explain_best(p)      — what the best move achieves and what the opponent threatened.
The deeper "why" is left to Claude in the chat; these texts only name the concrete consequence.
"""

import chess

from .engine import ENGINE
from .scenes import num_label

PASS = 8  # win-% points from the best move that still count as solved (same as the trainer)
VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
ACC = {chess.PAWN: "пешку", chess.KNIGHT: "коня", chess.BISHOP: "слона", chess.ROOK: "ладью", chess.QUEEN: "ферзя"}
ACC_PL = {chess.PAWN: "пешки", chess.KNIGHT: "коня", chess.BISHOP: "слона", chess.ROOK: "ладьи", chess.QUEEN: "ферзя"}
NOM = {chess.PAWN: "пешка", chess.KNIGHT: "конь", chess.BISHOP: "слон", chess.ROOK: "ладья", chess.QUEEN: "ферзь", chess.KING: "король"}
NUMS = {2: "две", 3: "три", 4: "четыре"}
NUMS_M = {2: "два", 3: "три", 4: "четыре"}

_threat_cache: dict[str, dict | None] = {}


def plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def pieces_text(types: list[int]) -> str:
    """[ROOK, PAWN, PAWN] -> 'ладью и две пешки' (accusative)."""
    parts = []
    for t in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN):
        n = types.count(t)
        if n == 1:
            parts.append(ACC[t])
        elif n > 1:
            fem = t in (chess.PAWN, chess.ROOK)
            word = (NUMS if fem else NUMS_M).get(n, str(n))
            noun = ACC_PL[t] if n < 5 else {chess.PAWN: "пешек", chess.ROOK: "ладей"}.get(t, ACC_PL[t] + "ей")
            parts.append(f"{word} {noun}")
    if not parts:
        return ""
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " и " + parts[-1]


def walk(board: chess.Board, moves: list[chess.Move], me: chess.Color) -> list[dict]:
    """Play a line, recording SAN, captures and the material balance from `me`'s point of view."""
    b = board.copy(stack=False)
    plies, bal = [], 0
    for mv in moves:
        if mv not in b.legal_moves:
            break
        mover = b.turn
        cap_sq = mv.to_square
        if b.is_en_passant(mv):
            cap_sq = mv.to_square + (-8 if mover == chess.WHITE else 8)
        captured = b.piece_at(cap_sq) if b.is_capture(mv) else None
        sign = 1 if mover == me else -1
        if captured:
            bal += sign * VAL[captured.piece_type]
        if mv.promotion:
            bal += sign * (VAL[mv.promotion] - 1)
        num, san = num_label(b), b.san(mv)
        before = b.fen()
        b.push(mv)
        plies.append(
            {
                "before": before,
                "uci": mv.uci(),
                "san": san,
                "num": num,
                "fen": b.fen(),
                "mine": mover == me,
                "captured": captured.piece_type if captured else None,
                "cap_sq": chess.square_name(cap_sq) if captured else None,
                "promo": mv.promotion,
                "bal": bal,
                "mate": b.is_checkmate(),
            }
        )
    return plies


def settled(plies: list[dict]) -> int:
    """Index of the last ply after which the material count is safe to quote:
    a trailing run of captures may still be answered, so it is not counted."""
    i = len(plies) - 1
    while i >= 0 and plies[i]["captured"] is not None and not plies[i]["mate"]:
        i -= 1
    return i


def material(plies: list[dict]) -> tuple[list[int], list[int], int]:
    """(my pieces lost, their pieces won, balance) up to the settled point; equal trades cancel out."""
    end = settled(plies)
    lost = [p["captured"] for p in plies[: end + 1] if p["captured"] and not p["mine"]]
    won = [p["captured"] for p in plies[: end + 1] if p["captured"] and p["mine"]]
    for t in list(lost):
        if t in won:
            lost.remove(t)
            won.remove(t)
    bal = plies[end]["bal"] if end >= 0 else 0
    return lost, won, bal


def trade_text(lost: list[int], won: list[int], bal: int) -> str:
    """Words for a material change: 'теряешь коня', 'теряешь качество', 'выигрываешь ладью'."""
    if bal <= -1:
        if lost == [chess.ROOK] and won in ([chess.KNIGHT], [chess.BISHOP]):
            return "теряешь качество"
        if lost and won:
            return f"отдаёшь {pieces_text(lost)} за {pieces_text(won)}"
        if lost:
            return f"теряешь {pieces_text(lost)}"
        return f"теряешь материал (около {-bal} {plural(-bal, 'пешки', 'пешек', 'пешек')})"
    if bal >= 1:
        if won == [chess.ROOK] and lost in ([chess.KNIGHT], [chess.BISHOP]):
            return "выигрываешь качество"
        if won and lost:
            return f"получаешь {pieces_text(won)} за {pieces_text(lost)}"
        if won:
            return f"выигрываешь {pieces_text(won)}"
        return f"выигрываешь материал (около {bal} {plural(bal, 'пешки', 'пешек', 'пешек')})"
    return ""


def line_text(plies: list[dict]) -> str:
    out = []
    for i, p in enumerate(plies):
        out.append(p["num"] + p["san"] if p["num"].endswith(".") or i == 0 else p["san"])
    return " ".join(out)


def mv_text(p: dict) -> str:
    return p["num"] + p["san"]


def public_line(plies: list[dict]) -> dict:
    """A line the UI can show on the board: start position + plies with SAN and FEN."""
    return {
        "start": plies[0]["before"] if plies else None,
        "plies": [{"uci": p["uci"], "san": p["san"], "num": p["num"], "fen": p["fen"]} for p in plies],
    }


class Lines:
    """Collects the lines quoted in an explanation; the text refers to them as {L0}, {L1}…
    so the UI can turn them into clickable moves that show the line on the board."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def ref(self, plies: list[dict]) -> str:
        if not plies:
            return ""
        self.items.append(public_line(plies))
        return "{L%d}" % (len(self.items) - 1)


def threat(fen: str, me: chess.Color, current_w: float) -> dict | None:
    """What the opponent would do if it were their move again (null-move search).
    Returned only when it is a real threat: mate, or a clear drop in our chances."""
    if fen in _threat_cache:
        return _threat_cache[fen]
    board = chess.Board(fen)
    res = None
    if not board.is_check() and board.turn == me:
        nb = board.copy(stack=False)
        nb.push(chess.Move.null())
        nb = chess.Board(nb.fen())
        if not nb.is_check():  # a null move must not leave our king en prise
            info = ENGINE.analyse(nb, nodes=600_000)[0]
            my_w = 100 - info["win"]
            if info["pv"] and (info["mate"] is not None and info["mate"] > 0 or current_w - my_w >= 20):
                plies = walk(nb, info["pv"][:10], me)
                lost, won, bal = material(plies)
                res = {"plies": plies, "mate": info["mate"] if (info["mate"] or 0) > 0 else None, "lost": lost, "won": won, "bal": bal, "my_w": my_w}
    _threat_cache[fen] = res
    return res


def threat_phrase(t: dict, L: "Lines | None" = None, line_len: int = 1) -> str:
    """'Соперник грозит 20.Nd5 …' — with L given, the move(s) become a clickable line."""
    first = t["plies"][0]
    moves = L.ref(t["plies"][:line_len]) if L else line_text(t["plies"][:line_len])
    if t["mate"]:
        return f"Соперник грозит {moves} с матом в {t['mate']} {plural(t['mate'], 'ход', 'хода', 'ходов')}"
    trade = trade_text(t["lost"], t["won"], t["bal"])
    if trade:
        return f"Соперник грозит {moves}: если не защититься, ты {trade}"
    return f"Соперник грозит {moves}" if first else ""


def best_w(p: dict) -> float:
    return max(w for w, _ in p["moves"].values())


def explain_move(p: dict, uci: str) -> dict:
    board = chess.Board(p["fen"])
    me = board.turn
    bw = best_w(p)
    w = p["moves"][uci][0]
    mv = chess.Move.from_uci(uci)
    after = board.copy(stack=False)
    after.push(mv)
    pv = [chess.Move.from_uci(u) for u in p["moves"][uci][1]]
    mate_in = None
    if not after.is_game_over():
        info = ENGINE.analyse(after, nodes=900_000)[0]
        if info["pv"]:
            pv = info["pv"][:12]
        if info["mate"] is not None and info["mate"] > 0:
            mate_in = info["mate"]
    plies = walk(board, [mv] + pv, me)
    mine, reply = plies[0], (plies[1] if len(plies) > 1 else None)
    ok = bw - w <= PASS
    L = Lines()
    shapes = []
    if reply:
        shapes.append({"orig": reply["uci"][:2], "dest": reply["uci"][2:4], "brush": "red"})
    main = public_line(plies)

    def result(text: str, ok_: bool) -> dict:
        return {"ok": ok_, "text": text, "lines": L.items, "line": main, "shapes": shapes if not ok_ else [], "w": w, "best": bw}

    if ok:
        return result("Ход держит позицию." if mine["uci"] != p["best"] else "Это лучший ход по оценке движка.", True)

    out = []
    if p["kind"] == "missed" and w >= 45:
        last = f" ({p['lastSan']})" if p.get("lastSan") else ""
        out.append(
            f"Ход не проигрывает ({round(w)}%), но упускает шанс: соперник только что ошибся{last}, "
            f"и здесь есть ход сильнее ({round(bw)}%). Ищи взятие, шах или угрозу."
        )
        return result(" ".join(out), False)

    t0 = threat(p["fen"], me, bw)
    if mate_in:
        out.append(f"После {L.ref([mine])} у соперника мат в {mate_in} {plural(mate_in, 'ход', 'хода', 'ходов')}: {L.ref(plies)}.")
    elif reply:
        cap = reply["captured"]
        if cap and reply["cap_sq"] == mine["uci"][2:4]:
            gender = "она стоит" if cap in (chess.PAWN, chess.ROOK) else "он стоит"
            out.append(f"{NOM[cap].capitalize()} на {reply['cap_sq']} — {gender} под боем, соперник забирает: {L.ref(plies[:2])}.")
            shapes.append({"orig": reply["cap_sq"], "brush": "red"})
        elif cap:
            out.append(f"Ход оставил без защиты {ACC[cap]} на {reply['cap_sq']}: соперник забирает {L.ref(plies[:2])}.")
            shapes.append({"orig": reply["cap_sq"], "brush": "red"})
        elif t0 and t0["plies"][0]["uci"] == reply["uci"]:
            out.append(f"Соперник грозил {L.ref(t0['plies'][:1])}, а твой ход эту угрозу не снимает: {L.ref(plies[:2])}.")
        else:
            out.append(f"Соперник отвечает {L.ref(plies[:2])}.")
        lost, won, bal = material(plies)
        trade = trade_text(lost, won, bal)
        if bal <= -1 and trade:
            out.append(f"В итоге варианта ты {trade}: {L.ref(plies)}.")
        else:
            t1 = threat(plies[1]["fen"], me, w) if len(plies) >= 2 else None
            if t1:
                ph = threat_phrase(t1, L, 4)
                out.append("Теперь " + ph[0].lower() + ph[1:] + ".")
                f = t1["plies"][0]
                shapes.append({"orig": f["uci"][:2], "dest": f["uci"][2:4], "brush": "orange"})
            elif bal >= 1 and trade:
                out.append(f"Ты {trade}, но позиция становится хуже: {L.ref(plies)}.")
            else:
                out.append(f"Материал сразу не теряешь, но позиция заметно хуже: {L.ref(plies)}.")
    out.append(f"Шансы: {round(w)}% против {round(bw)}% после лучшего хода.")
    return result(" ".join(out), False)


def explain_best(p: dict) -> dict:
    board = chess.Board(p["fen"])
    me = board.turn
    bw = best_w(p)
    best = chess.Move.from_uci(p["best"])
    pv = [chess.Move.from_uci(u) for u in p["moves"][p["best"]][1]]
    after = board.copy(stack=False)
    after.push(best)
    mate_in = None
    if not after.is_game_over():
        info = ENGINE.analyse(after, nodes=900_000)[0]
        if info["pv"] and len(info["pv"]) > len(pv):
            pv = info["pv"][:12]
        if info["mate"] is not None and info["mate"] < 0:
            mate_in = -info["mate"]
    plies = walk(board, [best] + pv, me)
    L = Lines()
    out = []
    t0 = threat(p["fen"], me, bw)
    if t0:
        out.append(threat_phrase(t0, L, 4) + ".")
    if mate_in:
        out.append(f"{L.ref(plies[:1])} ведёт к мату: {L.ref(plies)}.")
    else:
        lost, won, bal = material(plies)
        trade = trade_text(lost, won, bal)
        if bal >= 1 and trade:
            out.append(f"После {L.ref(plies[:1])} ты {trade}: {L.ref(plies)}.")
        elif t0:
            out.append(f"{L.ref(plies[:1])} эту угрозу снимает. Дальше: {L.ref(plies)}.")
        else:
            out.append(f"Лучшая линия: {L.ref(plies)}.")
    good = sum(1 for w, _ in p["moves"].values() if bw - w <= PASS)
    out.append(f"Надёжных ходов здесь {good} из {len(p['moves'])}.")
    shapes = [{"orig": p["best"][:2], "dest": p["best"][2:4], "brush": "green"}]
    if t0:
        f = t0["plies"][0]
        shapes.append({"orig": f["uci"][:2], "dest": f["uci"][2:4], "brush": "orange"})
    return {"text": " ".join(out), "lines": L.items, "line": public_line(plies), "shapes": shapes}
