"""Background jobs started from the app (by the user or by Claude in the chat):
fetch new Lichess games, analyse them with Stockfish, build puzzles, print the error report.
One job runs at a time — they all load the CPU. Progress is pushed to the windows over SSE.
"""

import asyncio
import collections
import itertools
import sys
import time

from .board import ROOT, S, broadcast

PY = sys.executable
STEPS = {
    "fetch_games": ("Скачать новые партии с Lichess", "scripts/fetch_games.py"),
    "analyze": ("Разобрать новые партии Stockfish", "scripts/analyze.py"),
    "make_puzzles": ("Составить задачи из ошибок", "scripts/make_puzzles.py"),
    "report": ("Отчёт по ошибкам", "scripts/report.py"),
}
PIPELINES = {"update": ("Обновить всё: партии → анализ → задачи", ["fetch_games", "analyze", "make_puzzles"])}
KINDS = {**{k: v[0] for k, v in STEPS.items()}, **{k: v[0] for k, v in PIPELINES.items()}}

_ids = itertools.count(1)
JOBS: dict[str, "Job"] = {}
_listeners: list = []


class Job:
    def __init__(self, kind: str, chat: str | None) -> None:
        self.id = f"j{next(_ids)}"
        self.kind = kind
        self.title = KINDS[kind]
        self.chat = chat
        self.status = "running"
        self.step: str | None = None
        self.started = time.time()
        self.ended: float | None = None
        self.lines: collections.deque[str] = collections.deque(maxlen=500)
        self.proc: asyncio.subprocess.Process | None = None

    def public(self, tail: int = 8) -> dict:
        return {
            "id": self.id, "kind": self.kind, "title": self.title, "status": self.status, "step": self.step,
            "seconds": round((self.ended or time.time()) - self.started), "tail": list(self.lines)[-tail:],
        }


def on_finish(cb) -> None:
    _listeners.append(cb)


async def _emit(job: Job) -> None:
    await broadcast({"type": "job", "job": job.public()})


async def start(kind: str, chat: str | None = None) -> Job:
    if kind not in KINDS:
        raise ValueError(f"unknown job {kind!r}; one of: {', '.join(KINDS)}")
    busy = [j for j in JOBS.values() if j.status == "running"]
    if busy:
        raise ValueError(f"job {busy[0].id} «{busy[0].title}» is still running")
    job = Job(kind, chat)
    JOBS[job.id] = job
    asyncio.create_task(_run(job))
    await _emit(job)
    return job


async def _run(job: Job) -> None:
    steps = PIPELINES[job.kind][1] if job.kind in PIPELINES else [job.kind]
    try:
        for step in steps:
            job.step = step
            job.lines.append(f"▶ {STEPS[step][0]}")
            await _emit(job)
            proc = await asyncio.create_subprocess_exec(
                PY, "-u", STEPS[step][1], cwd=ROOT,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            job.proc = proc
            last = 0.0
            assert proc.stdout is not None
            async for raw in proc.stdout:
                job.lines.append(raw.decode(errors="replace").rstrip())
                if time.time() - last > 0.7:
                    last = time.time()
                    await _emit(job)
            rc = await proc.wait()
            job.proc = None
            if rc != 0:
                job.status = "failed"
                job.lines.append(f"✗ код выхода {rc}")
                break
            if step == "make_puzzles":
                S.reload_puzzles()
                await broadcast({"type": "puzzles"})
        else:
            job.status = "done"
    except Exception as e:  # noqa: BLE001 — a failed job must still report
        job.status = "failed"
        job.lines.append(f"✗ {e}")
    finally:
        job.ended = time.time()
        await _emit(job)
        for cb in _listeners:
            try:
                await cb(job)
            except Exception:  # noqa: BLE001
                pass


async def cancel(job_id: str) -> None:
    job = JOBS.get(job_id)
    if job and job.proc and job.status == "running":
        job.proc.terminate()
        job.lines.append("✗ остановлено")
