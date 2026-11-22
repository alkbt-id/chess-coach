"""Inline the chessground board CSS into the trainer page: trainer/trainer.src.html -> trainer/trainer.html."""

from pathlib import Path

T = Path(__file__).resolve().parent.parent / "trainer"
css = "\n".join((T / "vendor" / f).read_text() for f in ("chessground.base.css", "board.lichess-brown.css", "pieces.merida.css"))
src = (T / "trainer.src.html").read_text()
(T / "trainer.html").write_text(src.replace("/*CHESSGROUND_CSS*/", css))
print("built", T / "trainer.html")
