"""Opening names for positions: the Lichess opening table (coach/openings.tsv, lichess-org/chess-openings,
CC0 public domain) — ECO code, English name and the moves of every named line.

A position gets the name of the line that ends in it (any move order). The family is the part of the name
before the colon («Italian Game: Giuoco Piano» → «Italian Game»); its start is the shortest line with just
the family name. Russian names exist for the common families; others stay in English.
"""

import csv
from functools import lru_cache
from pathlib import Path

import chess

TSV = Path(__file__).resolve().parent / "openings.tsv"

RU = {
    "Italian Game": "Итальянская партия", "Ruy Lopez": "Испанская партия", "Scotch Game": "Шотландская партия",
    "Four Knights Game": "Партия четырёх коней", "Three Knights Opening": "Партия трёх коней",
    "Petrov's Defense": "Русская партия", "Philidor Defense": "Защита Филидора", "Vienna Game": "Венская партия",
    "Bishop's Opening": "Дебют слона", "King's Gambit Accepted": "Королевский гамбит", "King's Gambit Declined": "Королевский гамбит",
    "King's Pawn Game": "Дебют королевской пешки", "King's Knight Opening": "Дебют королевского коня",
    "Center Game": "Центральный дебют", "Danish Gambit Accepted": "Датский гамбит", "Ponziani Opening": "Дебют Понциани",
    "Latvian Gambit": "Латышский гамбит", "Latvian Gambit Accepted": "Латышский гамбит", "Elephant Gambit": "Гамбит слона",
    "Sicilian Defense": "Сицилианская защита", "French Defense": "Французская защита", "Caro-Kann Defense": "Защита Каро — Канн",
    "Scandinavian Defense": "Скандинавская защита", "Pirc Defense": "Защита Пирца", "Modern Defense": "Современная защита",
    "Alekhine Defense": "Защита Алёхина", "Nimzowitsch Defense": "Защита Нимцовича", "Owen Defense": "Защита Оуэна",
    "Queen's Pawn Game": "Дебют ферзевой пешки", "Queen's Gambit Declined": "Отказанный ферзевый гамбит",
    "Queen's Gambit Accepted": "Принятый ферзевый гамбит", "Queen's Gambit": "Ферзевый гамбит", "Slav Defense": "Славянская защита",
    "Semi-Slav Defense": "Полуславянская защита", "London System": "Лондонская система", "Colle System": "Система Колле",
    "Torre Attack": "Атака Торре", "Trompowsky Attack": "Атака Тромповского", "Richter-Veresov Attack": "Атака Рихтера — Вересова",
    "Blackmar-Diemer Gambit": "Гамбит Блэкмара — Димера", "Blackmar-Diemer Gambit Accepted": "Гамбит Блэкмара — Димера",
    "Rapport-Jobava System": "Система Раппорта — Йобавы", "Tarrasch Defense": "Защита Тарраша", "Catalan Opening": "Каталонское начало",
    "King's Indian Defense": "Староиндийская защита", "Old Indian Defense": "Староиндийская защита (старая)",
    "Grünfeld Defense": "Защита Грюнфельда", "Nimzo-Indian Defense": "Защита Нимцовича (новоиндийская)",
    "Queen's Indian Defense": "Новоиндийская защита", "Bogo-Indian Defense": "Защита Боголюбова",
    "Benoni Defense": "Защита Бенони", "Benko Gambit": "Гамбит Бенко", "Benko Gambit Accepted": "Гамбит Бенко",
    "Dutch Defense": "Голландская защита", "Indian Defense": "Индийская защита", "Englund Gambit": "Гамбит Энглунда",
    "English Opening": "Английское начало", "Réti Opening": "Дебют Рети", "Zukertort Opening": "Дебют Цукерторта",
    "King's Indian Attack": "Староиндийское нападение", "Bird Opening": "Дебют Берда", "Nimzo-Larsen Attack": "Дебют Ларсена",
    "Polish Opening": "Польское начало", "Hungarian Opening": "Венгерское начало", "Grob Opening": "Дебют Гроба",
    "Van Geet Opening": "Дебют ван Гета", "Hippopotamus Defense": "Защита «Бегемот»",
    # variations that are sections of their own (coach/repertoire.py: the variation of a too wide family)
    "King's Pawn Game: Wayward Queen Attack": "Ранний выпад ферзя (2.Qh5)",
    "Queen's Pawn Game: Chigorin Variation": "Вариант Чигорина (2.Nf3 Nc6)",
    "Queen's Pawn Game: Colle System": "Система Колле", "Queen's Pawn Game: Zukertort Variation": "Система Цукерторта",
    "Queen's Pawn Game: Levitsky Attack": "Атака Левицкого", "Queen's Pawn Game: Torre Attack": "Атака Торре",
    "Queen's Pawn Game: Veresov Attack": "Атака Вересова", "Indian Defense: Knights Variation": "Индийская защита: вариант двух коней",
    "King's Knight Opening: Normal Variation": "Дебют королевского коня", "Zukertort Opening: Queen's Gambit Invitation": "Дебют Цукерторта",
}


def key(board: chess.Board) -> str:
    """The position without the move counters: the same position reached by another move order matches."""
    return " ".join(board.fen().split()[:4])


def family(name: str) -> str:
    return name.split(":")[0].split(",")[0].strip()


def ru(name: str) -> str:
    """«Italian Game: Giuoco Piano» → «Итальянская партия: Giuoco Piano»; unknown families stay in English."""
    if name in RU:
        return RU[name]
    fam = family(name)
    return RU[fam] + name[len(fam):] if fam in RU else name


@lru_cache(maxsize=1)
def _table() -> tuple[dict, dict]:
    """(position key → (eco, name, plies)), (family → shortest line [uci])."""
    by_pos: dict[str, tuple[str, str, int]] = {}
    starts: dict[str, list[str]] = {}
    with TSV.open(encoding="utf-8") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            b = chess.Board()
            try:
                for tok in row["pgn"].split():
                    if not tok[0].isdigit():
                        b.push_san(tok)
            except ValueError:
                continue
            k, n = key(b), len(b.move_stack)
            if k not in by_pos or n < by_pos[k][2]:
                by_pos[k] = (row["eco"], row["name"], n)
            if row["name"] == family(row["name"]) and (row["name"] not in starts or n < len(starts[row["name"]])):
                starts[row["name"]] = [m.uci() for m in b.move_stack]
    return by_pos, starts


def name_at(board: chess.Board) -> tuple[str, str] | None:
    """(eco, name) of the position, or None when no named line ends in it."""
    hit = _table()[0].get(key(board))
    return (hit[0], hit[1]) if hit else None


def name_along(ucis: list[str]) -> str | None:
    """The name of the deepest named position along a line from the initial position."""
    b, best = chess.Board(), None
    for u in ucis:
        b.push(chess.Move.from_uci(u))
        if (hit := name_at(b)) is not None:
            best = hit[1]
    return best


def family_start(fam: str) -> list[str] | None:
    """The moves (UCI) where a family begins, e.g. Italian Game → e2e4 e7e5 g1f3 b8c6 f1c4."""
    return _table()[1].get(fam)
