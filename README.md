# Шахматный тренер

**Личный шахматный тренер для macOS: разбор своих партий со Stockfish, задачи из своих же ошибок и Claude в чате рядом с доской.**

Приложение скачивает ваши партии с Lichess, прогоняет каждый ход через Stockfish, находит, где вы зеваете, и превращает эти позиции в задачи. Рядом с доской — чат с Claude: он видит ту же позицию, проверяет варианты движком и сам показывает их на доске.

## Что умеет

- **Разбор.** Доска с деревом ходов как на Lichess: ваши ходы становятся вариантами, шкала оценки и панель Stockfish рядом. Любой ход в тексте кликается и показывает позицию.
- **Обзор партии.** Stockfish смотрит каждый ход и ставит ?! / ? / ?? на неточности, ошибки и зевки, а лучший ход добавляет вариантом.
- **Задачи из ваших ошибок.** Два вида: позиция перед вашим зевком («не зевни») и позиция, где соперник зевнул, а вы не наказали («накажи»). Объяснение, почему ход плохой, строится из линий Stockfish.
- **Задачи Lichess по слабым темам.** Рейтинговые задачи Lichess, подобранные под темы, где вы ошибаетесь чаще.
- **Игра на Lichess.** Живые партии с вашего аккаунта. Пока идёт партия, движок, анализ и чат закрыты — Lichess запрещает подсказки.
- **Claude в чате.** Несколько чатов, выбор модели и усилия. Claude работает через ваш вход в Claude Code (без API-ключа), пользуется доской и Stockfish сам, а на остальное спрашивает разрешение в чате.

## Установка

Нужны macOS, Swift (Xcode или Command Line Tools), [uv](https://docs.astral.sh/uv/), Stockfish и [Claude Code](https://code.claude.com/docs), в котором вы вошли в аккаунт (только для чата).

```bash
brew install stockfish uv
git clone https://github.com/alkbt-id/chess-coach.git ~/develop/chess
cd ~/develop/chess
uv sync
./scripts/fetch_sounds.sh   # звуки ходов Lichess; без них приложение работает беззвучно
./mac/build.sh
open ~/Applications/Шахматный\ тренер.app
```

`mac/build.sh` собирает окно в `~/Applications/Шахматный тренер.app`. Окно само запускает локальный сервер на `127.0.0.1:8737`. Без окна сервер запускается так: `uv run python -m coach`, интерфейс — в браузере на <http://127.0.0.1:8737/>.

Это личный проект, и часть настроек пока зашита в код:

- папка проекта — `projectRoot` в [mac/main.swift](mac/main.swift) (`~/develop/chess` у автора);
- ник на Lichess — `USER` в [scripts/](scripts/) и `HISTORY_USER` в [coach/review.py](coach/review.py);
- путь к Stockfish — `STOCKFISH` в [coach/engine.py](coach/engine.py) (`/opt/homebrew/bin/stockfish`).

## Свои партии и задачи

Задачи строятся из ваших партий в три шага, четвёртый печатает сводку ошибок. Всё это запускается из приложения (фоновые задания) или из терминала:

```bash
uv run scripts/fetch_games.py    # новые партии с Lichess → data/lichess/games.ndjson
uv run scripts/analyze.py        # Stockfish по каждому ходу → data/analysis/moves.jsonl
uv run scripts/make_puzzles.py   # задачи из ошибок → trainer/puzzles.json
uv run scripts/report.py         # сводка: точность, ошибки по фазам и по времени
```

Все личные данные лежат в `data/` и в репозиторий не попадают: токен Lichess, чаты, партии, прогресс по задачам.

## Claude Code вне приложения

[coach/mcp_server.py](coach/mcp_server.py) даёт Claude Code в терминале или редакторе те же инструменты доски, что и чату в приложении:

```bash
claude mcp add --scope local chess-board -e PYTHONPATH=$PWD -- $PWD/.venv/bin/python -m coach.mcp_server
```

## Сторонний код

- [chessground](https://github.com/lichess-org/chessground) — доска, GPL-3.0 ([лицензия](coach/web/vendor/chessground/LICENSE)).
- [chess.js](https://github.com/jhlywa/chess.js) — правила и PGN в интерфейсе, BSD-2-Clause.
- [python-chess](https://github.com/niklasf/python-chess) — правила и связь со Stockfish, GPL-3.0.
- Фигуры Merida и доска brown — из [lila](https://github.com/lichess-org/lila), GPLv2+.
- Звуки Lichess не входят в репозиторий (они несвободные) — их скачивает `scripts/fetch_sounds.sh`.
