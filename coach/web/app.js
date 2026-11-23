// Шахматный тренер — UI.
//   study  — Lichess-style analysis: a move tree per diagram (Claude's lines + the user's own moves), Stockfish panel;
//   puzzle — positions from the user's games with engine-based reasons for wrong moves;
//   chat   — Claude (Claude Code via the Agent SDK) with tools for the board, engine, puzzles and jobs.
// Any move written in text (chat, comments, explanations) is clickable and previews the line on the board.
// The server pushes changes over SSE (/api/events); the UI reports what it shows to /api/view.
import { Chessground } from "./vendor/chessground/chessground.min.js";
import { Chess } from "./vendor/chess.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const http = {
  get: (u) => fetch(u).then((r) => r.json()),
  send: (method, u, b) =>
    fetch(u, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.status);
      return d;
    }),
};
const post = (u, b) => http.send("POST", u, b);
const turnOf = (fen) => (fen.split(" ")[1] === "w" ? "white" : "black");
const other = (c) => (c === "white" ? "black" : "white");
const sq = (u) => [u.slice(0, 2), u.slice(2, 4)];
const pct = (w) => `${Math.round(w)}%`;
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const fenKey = (f) => f.split(" ").slice(0, 4).join(" ");
const CLIENT = Math.random().toString(36).slice(2);
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GLYPH_CLASS = { "!": "g-good", "!!": "g-brill", "?": "g-mist", "??": "g-blun", "!?": "g-int", "?!": "g-dub" };
const GLYPH_FILL = { "!": "#22ac38", "!!": "#168226", "?": "#e69f00", "??": "#df5353", "!?": "#ea45d8", "?!": "#56b4e9" };

// numbering for plies played from `fen`: "25." / "25…"
function numLabels(fen, n) {
  const [, side, , , , full] = fen.split(" ");
  let num = Number(full), white = side === "w";
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(white ? `${num}.` : `${num}…`);
    if (!white) num++;
    white = !white;
  }
  return out;
}

// a line of UCI moves -> {start, plies: [{san, uci, fen, num}]}
function playLine(fen, ucis) {
  const c = new Chess(fen);
  const plies = [];
  const nums = numLabels(fen, ucis.length);
  for (const [i, u] of ucis.entries()) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      plies.push({ san: m.san, uci: m.from + m.to + (m.promotion || ""), fen: c.fen(), num: nums[i] });
    } catch { break; }
  }
  return { start: fen, plies };
}

// ---------------- Markdown + clickable moves ----------------
const TOK = String.raw`(?:\d+(?:\.\.\.|…|\.)\s?)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?(?:!!|\?\?|!\?|\?!|!|\?)?`;
const SEQ_RE = new RegExp(String.raw`(^|[\s(«"'—–,;:\[])(${TOK}(?:\s+${TOK})*)(?=$|[\s).,;:!?»"'—–\]])`, "g");
const TOK_RE = new RegExp(TOK, "g");
const isPieceMove = (t) => /^(\d+(\.\.\.|…|\.)\s?)/.test(t) || /^[KQRBNO]/.test(t) || t.includes("x");

function linkMoves(escaped, stash = (h) => h) {
  const moved = escaped.replace(SEQ_RE, (all, pre, seq) => {
    const toks = seq.match(TOK_RE) || [];
    if (toks.length === 1 && !isPieceMove(toks[0])) return all; // a lone "e4" is treated as a square below
    let i = 0;
    const inner = seq.replace(TOK_RE, (t) => `<b class="mvl" data-i="${i++}">${t}</b>`);
    return `${pre}${stash(`<span class="mseq">${inner}</span>`)}`;
  });
  const mark = (text, keys) => stash(`<span class="sqr" data-sqs="${keys.join(",")}">${text}</span>`);
  return moved
    // a line between two squares: "a1–h8", "b7-d5"
    .replace(/(^|[^\w\u0001])([a-h][1-8])\s?[-–—]\s?([a-h][1-8])(?![\w\u0001])/g, (all, pre, a, b) => {
      const keys = squaresBetween(a, b);
      return keys ? `${pre}${mark(`${a}–${b}`, keys)}` : all;
    })
    // single squares
    .replace(/(^|[^\w\u0001-])([a-h][1-8])(?![\w\u0001])/g, (_, pre, q) => `${pre}${mark(q, [q])}`)
    // ranks: "7-я горизонталь", "на 2-й горизонтали"
    .replace(/(^|[^\w\u0001])([1-8])(-?(?:я|й|ю|ой|ая|ую))?(\s+горизонтал[а-яё]*)/g, (_, pre, r, suf = "", word) =>
      `${pre}${mark(r + suf + word, "abcdefgh".split("").map((f) => f + r))}`)
    // files: Latin a–h standing alone ("пешки c и e", "линия d", "c-пешка")
    .replace(/(^|[^\w\u0001])([a-h])(?=$|[^\w\u0001])/g, (all, pre, f, off, str) =>
      /^\s+[A-Za-z]{2}/.test(str.slice(off + all.length)) ? all // "a test": an English word, not a file
        : `${pre}${mark(f, [1, 2, 3, 4, 5, 6, 7, 8].map((r) => f + r))}`);
}

// squares on the straight line from a to b (inclusive) if they share a file, rank or diagonal
function squaresBetween(a, b) {
  const [fa, ra, fb, rb] = [a.charCodeAt(0) - 97, Number(a[1]), b.charCodeAt(0) - 97, Number(b[1])];
  const df = Math.sign(fb - fa), dr = Math.sign(rb - ra);
  const n = Math.max(Math.abs(fb - fa), Math.abs(rb - ra));
  if (!(fa === fb || ra === rb || Math.abs(fb - fa) === Math.abs(rb - ra)) || n === 0) return null;
  return Array.from({ length: n + 1 }, (_, i) => String.fromCharCode(97 + fa + i * df) + (ra + i * dr));
}

// lines referenced from explanations ({L0} …), looked up when a move in them is clicked
const LINES = new Map();
let lineSeq = 0;
function regLine(line) {
  const key = `l${++lineSeq}`;
  LINES.set(key, line);
  if (LINES.size > 400) LINES.delete(LINES.keys().next().value);
  return key;
}

function inline(text, lines = null) {
  const keep = [];
  const stash = (html) => { keep.push(html); return `\u0001${keep.length - 1}\u0001`; };
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => stash(`<code>${c}</code>`));
  // a line with the moves that lead to it, written by Claude and hidden (wayLine): [3...Bf5](#1.d4 d5 2.c4 dxc4 3.e3)
  // shows «3...Bf5». While a reply streams in, an unfinished one at the end shows its moves only.
  s = s.replace(/\[([^\]\n]+)\]\(#([^)\n]*)(\)|$)/g, (_, shown, way, end) => {
    let i = 0;
    const inner = shown.replace(TOK_RE, (t) => `<b class="mvl" data-i="${i++}">${t}</b>`);
    if (!i) return shown;
    return stash(end ? `<span class="mseq" data-way="${way.trim()}">${inner}</span>` : `<span class="mseq">${inner}</span>`);
  });
  if (lines) {
    s = s.replace(/\{L(\d+)\}/g, (_, k) => {
      const ln = lines[Number(k)];
      if (!ln?.plies?.length) return "";
      const key = regLine(ln);
      return stash(`<span class="mseq" data-line="${key}">${ln.plies.map((p, i) =>
        `${p.num.endsWith(".") || i === 0 ? p.num : ""}<b class="mvl" data-i="${i}">${esc(p.san)}</b>`).join(" ")}</span>`);
    });
  }
  s = linkMoves(s, stash);
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, k) => keep[Number(k)]);
}

function md(src, lines = null) {
  if (!src) return "";
  const out = [];
  String(src).replace(/\r/g, "").split(/```/).forEach((part, bi) => {
    if (bi % 2 === 1) { out.push(`<pre><code>${esc(part.replace(/^\w*\n/, ""))}</code></pre>`); return; }
    let para = [], list = null, table = null;
    const flushPara = () => { if (para.length) out.push(`<p>${para.map((l) => inline(l, lines)).join("<br>")}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x, lines)}</li>`).join("")}</${list.tag}>`); list = null; };
    const flushTable = () => {
      if (table) {
        const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        out.push(`<table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${inline(c, lines)}</th>` : `<td>${inline(c, lines)}</td>`)).join("")}</tr>`).join("")}</table>`);
      }
      table = null;
    };
    const flush = () => { flushPara(); flushList(); flushTable(); };
    for (const l of part.split("\n")) {
      let m;
      if (!l.trim()) { flush(); continue; }
      if (/^\s*\|.*\|\s*$/.test(l)) { flushPara(); flushList(); (table ||= []).push(l); continue; }
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { flush(); out.push(`<h3>${inline(m[2], lines)}</h3>`); continue; }
      if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); flushTable(); if (list?.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
      if ((m = l.match(/^\s*\d+[.)]\s+(.*)/)) && !/^\s*\d+\.\s*(O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8])/.test(l)) {
        flushPara(); flushTable();
        if (list?.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = l.match(/^>\s?(.*)/))) { flush(); out.push(`<blockquote>${inline(m[1], lines)}</blockquote>`); continue; }
      flushList(); flushTable();
      para.push(l);
    }
    flush();
  });
  return out.join("");
}

// ---------------- board ----------------
let mode = "puzzle";
let shownFen = START_FEN;
let userShapes = [];

const cg = Chessground($("#board"), {
  coordinates: true,
  animation: { enabled: true, duration: 200 },
  movable: { free: false, showDests: true },
  premovable: { enabled: false },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  drawable: {
    enabled: true,
    brushes: { orange: { key: "o", color: "#e68a00", opacity: 1, lineWidth: 10 } },
    onChange: (shapes) => { userShapes = shapes; reportView(); },
  },
});

// chessground remembers where the board is on screen and re-measures only on scroll, window resize or a board resize.
// The board also moves without resizing (chat hidden, a live game centred, the eval bar shown), and clicks then
// landed on the wrong squares. Re-measure on every press, before chessground handles it.
for (const t of ["mousedown", "touchstart"]) {
  $("#board").addEventListener(t, () => cg.state.dom.bounds.clear(), { capture: true, passive: true });
}

// Touch screens: arrows drawn with a finger. A mouse draws with the right button (chessground), but to chessground a
// finger always moves pieces; the pencil under the board turns the board into a drawing surface until it is pressed
// again: a drag draws an arrow, a tap rings a square, the same one again takes it away (as with the mouse). These
// listeners come before the swipe's and stop the touch there, so nothing moves and no page turns while drawing.
let drawMode = false;
const drawTouch = { from: null };
function setDrawMode(on) {
  drawMode = on;
  const b = $("#draw-btn");
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  $("#board-wrap").classList.toggle("drawing", on);
}
$("#draw-btn").addEventListener("click", () => setDrawMode(!drawMode));
const keyAtTouch = (t) => { cg.state.dom.bounds.clear(); return cg.getKeyAtDomPos([t.clientX, t.clientY]); };
function drawStop(e) { e.preventDefault(); e.stopImmediatePropagation(); }
$("#board-wrap").addEventListener("touchstart", (e) => {
  if (!drawMode) return;
  drawStop(e);
  drawTouch.from = e.touches.length === 1 ? keyAtTouch(e.touches[0]) : null;
}, { capture: true, passive: false });
$("#board-wrap").addEventListener("touchmove", (e) => { if (drawMode) drawStop(e); }, { capture: true, passive: false });
$("#board-wrap").addEventListener("touchend", (e) => {
  if (!drawMode) return;
  drawStop(e);
  const from = drawTouch.from, t = e.changedTouches[0];
  drawTouch.from = null;
  const to = t && keyAtTouch(t);
  if (!from || !to) return;
  const shape = from === to ? { orig: from, brush: "green" } : { orig: from, dest: to, brush: "green" };
  const same = (s) => s.orig === shape.orig && (s.dest || null) === (shape.dest || null);
  const shapes = cg.state.drawable.shapes;
  userShapes = shapes.some(same) ? shapes.filter((s) => !same(s)) : [...shapes, shape];
  cg.setShapes(userShapes);
  reportView(); // Claude sees the user's arrows, as with the mouse
}, { capture: true, passive: false });

// One-finger swipe across the board (the iPad): right to left = next move, left to right = previous, like turning a
// page. A press that starts a move (a piece that can move, or a target of the selected piece) stays a move.
const swipe = { start: null };
function pressMoves(key) {
  const st = cg.state;
  const piece = key && st.pieces.get(key);
  if (piece && (st.movable.color === "both" || st.movable.color === piece.color)) return true; // a move or a premove
  return !!(key && st.selected && st.movable.dests?.get(st.selected)?.includes(key));
}
$("#board-wrap").addEventListener("touchstart", (e) => {
  swipe.start = null;
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  cg.state.dom.bounds.clear();
  if (pressMoves(cg.getKeyAtDomPos([t.clientX, t.clientY]))) return;
  swipe.start = { x: t.clientX, y: t.clientY, at: Date.now(), fen: shownFen };
}, { capture: true, passive: true });
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) swipe.start = null; }, { passive: true });
document.addEventListener("touchend", (e) => {
  const s = swipe.start;
  swipe.start = null;
  const t = e.changedTouches[0];
  if (!s || !t || shownFen !== s.fen || Date.now() - s.at > 1000) return;
  const dx = t.clientX - s.x, dy = t.clientY - s.y;
  if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
  cg.selectSquare(null);
  swipeStep(dx < 0 ? "next" : "prev");
}, { passive: true });

// chessground rebuilds the board when the orientation flips (and on redrawAll). A redraw queued just before that
// still runs on the old, detached board and marks the shapes as drawn, so the new board kept stale arrows
// (Stockfish's arrow from «Разбор» stayed over the game in «Игра»). One frame later all shapes are drawn again.
let shapesFrame = 0;
function resyncShapes() {
  if (shapesFrame) return;
  shapesFrame = requestAnimationFrame(() => {
    shapesFrame = 0;
    cg.state.drawable.prevSvgHash = "-"; // never a real hash: the next redraw compares every shape with the screen
    cg.state.dom.redrawNow();
  });
}
function setAutoShapes(shapes) {
  cg.setAutoShapes(shapes);
  resyncShapes();
}

// ---------------- layout: columns the user can resize, the board fitted to what is left ----------------
const LAY = { gutter: 10, padX: 26, padY: 24, meta: 30 + 2 * 38, minSide: 280, minChat: 300, prefSide: 360, prefChat: 430, cur: null };
let customCols = null; // {side, chat} once the user dragged a gutter; double-click a gutter to go back to auto
try { customCols = JSON.parse(localStorage.getItem("layout.cols") || "null"); } catch {}

function layout() {
  const L = $("#layout");
  if (!L.clientWidth) return;
  const W = L.clientWidth - LAY.padX;
  const H = L.clientHeight - LAY.padY - LAY.meta - ($("#nav").offsetHeight + 4) - ($("#btabs").offsetHeight ? $("#btabs").offsetHeight + 4 : 0); // the move buttons under the board, the tabs over it
  const chatOn = !L.classList.contains("no-chat");
  const evalW = $("#evalbar").hidden ? 0 : 22;
  const gut = LAY.gutter * (chatOn ? 2 : 1);
  let side = customCols?.side ?? LAY.prefSide;
  let chat = chatOn ? (customCols?.chat ?? LAY.prefChat) : 0;
  const room = () => W - gut - evalW - side - chat;
  // auto: below 520px the panels give up width before the board does; after a drag the user decides
  const want = customCols ? Math.min(H, 200) : Math.min(H, 520);
  if (room() < want) {
    const need = want - room();
    const canSide = Math.max(0, side - LAY.minSide), canChat = chatOn ? Math.max(0, chat - LAY.minChat) : 0;
    const total = canSide + canChat || 1;
    side -= Math.min(canSide, (need * canSide) / total);
    chat -= Math.min(canChat, (need * canChat) / total);
  }
  const board = Math.max(160, Math.floor(Math.min(H, room()) / 8) * 8);
  const extra = W - gut - evalW - board - side - chat;
  if (extra > 0) { // the board is limited by height: the spare width goes to the panels, keeping their ratio
    const tot = side + chat;
    side += (extra * side) / tot;
    chat += (extra * chat) / tot;
  }
  side = Math.floor(side);
  chat = Math.floor(chat);
  const live = document.body.classList.contains("live"); // a live game: board and clocks side by side in the middle
  if (live) side = Math.min(side, 460);
  L.style.justifyContent = live ? "center" : "";
  // chat | board | moves panel — the board in the middle, as on Lichess
  L.style.gridTemplateColumns = `${chatOn ? `${chat}px ${LAY.gutter}px ` : ""}${board + evalW}px ${LAY.gutter}px ${side}px`;
  const wrap = $("#board-wrap");
  if (wrap.offsetWidth !== board) {
    wrap.style.width = wrap.style.height = `${board}px`;
    cg.redrawAll();
    resyncShapes();
  }
  LAY.cur = { side, chat, board };
}
new ResizeObserver(() => layout()).observe($("#layout"));

function dragGutter(id) {
  const g = $(id);
  g.addEventListener("pointerdown", (e) => {
    if (!LAY.cur) return;
    e.preventDefault();
    try { g.setPointerCapture(e.pointerId); } catch {}
    const x0 = e.clientX, s0 = LAY.cur.side, c0 = LAY.cur.chat;
    g.classList.add("drag");
    document.body.classList.add("resizing");
    const move = (ev) => {
      const dx = ev.clientX - x0;
      // g2 (chat | board): wider chat to the right; g1 (board | moves panel): narrower panel to the right
      const side = id === "#g1" ? Math.max(LAY.minSide, s0 - dx) : s0;
      const chat = id === "#g2" ? Math.max(LAY.minChat, c0 + dx) : c0;
      customCols = { side, chat: chat || customCols?.chat || LAY.prefChat };
      layout();
    };
    const up = () => {
      g.classList.remove("drag");
      document.body.classList.remove("resizing");
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      try { localStorage.setItem("layout.cols", JSON.stringify(customCols)); } catch {}
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
  });
  g.addEventListener("dblclick", () => {
    customCols = null;
    try { localStorage.removeItem("layout.cols"); } catch {}
    layout();
  });
}
dragGutter("#g1");
dragGutter("#g2");

// scroll `el` into view inside `box` only (scrollIntoView may also scroll the page sideways)
function scrollNearest(el, box) {
  if (!el || !box) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
}

function legalDests(fen) {
  const d = new Map();
  for (const m of new Chess(fen).moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    if (!d.get(m.from).includes(m.to)) d.get(m.from).push(m.to);
  }
  return d;
}

function setBoard({ fen, orientation, lastMove, shapes = [], movable = null, premove = false }) {
  const c = new Chess(fen);
  const changed = fen !== shownFen;
  shownFen = fen;
  if (!premove) cg.cancelPremove();
  cg.set({
    fen,
    orientation,
    turnColor: turnOf(fen),
    lastMove,
    check: c.inCheck() ? turnOf(fen) : false,
    movable: movable ? { color: movable.color, dests: movable.dests, events: { after: movable.after } } : { color: undefined, dests: new Map() },
    // live games only: a move made during the opponent's turn waits for it
    premovable: { enabled: premove, events: { set: premove ? (o, d) => onPremoveSet(o, d) : undefined } },
  });
  setAutoShapes(shapes);
  if (changed) { cg.setShapes([]); userShapes = []; }
  renderMaterial();
  scheduleHighlight();
}

// ---------------- promotion: the user picks the piece, as on Lichess ----------------
// A column of four pieces over the board from the promotion square towards the middle.
// Resolves to "q" | "n" | "r" | "b", or null when the user clicks elsewhere or presses Esc.
const PROMO_ROLE = { q: "queen", n: "knight", r: "rook", b: "bishop" };
const PROMO_NAME = { q: "Ферзь", n: "Конь", r: "Ладья", b: "Слон" };
let promo = null; // the open choice: {el, done}

function isPromotion(fen, orig, dest) {
  try { return new Chess(fen).moves({ verbose: true }).some((m) => m.from === orig && m.to === dest && m.promotion); } catch { return false; }
}

function choosePromotion(dest, color) {
  closePromotion();
  return new Promise((resolve) => {
    const white = cg.state.orientation === "white";
    const file = dest.charCodeAt(0) - 97, rank = Number(dest[1]) - 1;
    const col = white ? file : 7 - file;
    const row = white ? 7 - rank : rank; // 0 = the top edge of the board
    const dir = row === 0 ? 1 : -1;
    const el = document.createElement("div");
    el.className = "promo cg-wrap";
    el.innerHTML = ["q", "n", "r", "b"].map((p, i) =>
      `<button type="button" class="promo-sq" data-p="${p}" title="${PROMO_NAME[p]}" style="left:${col * 12.5}%;top:${(row + dir * i) * 12.5}%"><piece class="${PROMO_ROLE[p]} ${color}"></piece></button>`).join("");
    const done = (v) => { el.remove(); if (promo?.el === el) promo = null; resolve(v); };
    el.addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); done(b ? b.dataset.p : null); });
    $("#board-wrap").append(el);
    promo = { el, done };
  });
}

function closePromotion() { promo?.done(null); }

// ---------------- material difference above and below the board ----------------
const ROLE = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function renderMaterial() {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of shownFen.split(" ")[0]) {
    const t = ch.toLowerCase();
    if (t in VALUE) count[ch === t ? "b" : "w"][t]++;
  }
  const score = (side) => Object.keys(VALUE).reduce((a, t) => a + VALUE[t] * (count[side][t] - count[side === "w" ? "b" : "w"][t]), 0);
  const row = (side) => {
    const opp = side === "w" ? "b" : "w";
    const groups = ["q", "r", "b", "n", "p"].map((t) => {
      const n = count[side][t] - count[opp][t];
      // the extra pieces in the colour of the side that has them ("black is a queen up" = a black queen)
      return n > 0 ? `<span class="grp">${`<piece class="${ROLE[t]} ${side === "w" ? "white" : "black"}"></piece>`.repeat(n)}</span>` : "";
    }).join("");
    const sc = score(side);
    return groups + (sc > 0 ? `<span class="adv">+${sc}</span>` : "");
  };
  const bottom = cg.state.orientation === "white" ? "w" : "b";
  $("#mat-bottom").innerHTML = row(bottom);
  $("#mat-top").innerHTML = row(bottom === "w" ? "b" : "w");
}

function glyphShape(node) {
  if (!node?.glyph || !node.uci) return [];
  return [{ orig: node.uci.slice(2, 4), label: { text: node.glyph, fill: GLYPH_FILL[node.glyph] || "#888" } }];
}

function renderBoard() {
  if (preview) {
    const p = preview.idx >= 0 ? preview.plies[preview.idx] : null;
    const fen = p ? p.fen : preview.start;
    setBoard({ fen, orientation: boardOrientation(), lastMove: p ? sq(p.uci) : undefined, shapes: engineArrow(fen) });
    requestEval(); // in «Разбор» Stockfish counts the line's position as well
    renderCeval();
    renderEvalBar();
    return;
  }
  if (mode === "study") studyBoard(); else if (mode === "play") playBoard(); else puzzleBoard();
}

function boardOrientation() {
  if (mode === "study") { const o = scene()?.orientation || "white"; return study.flipped ? other(o) : o; }
  if (mode === "play") { const o = pgame()?.color || "white"; return play.flipped ? other(o) : o; }
  const p = lp.on ? lp.cur : pz.cur; // Lichess puzzles keep their own current puzzle
  return p ? (pz.flipped ? other(p.color) : p.color) : "white";
}

// ---------------- reporting to the server (Claude reads it) ----------------
let reportTimer = null;
function reportView() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    const v = {
      mode, fen: shownFen, orientation: cg.state.orientation, engineOn: study.engine && mode === "study",
      userShapes: userShapes.map((s) => ({ from: s.orig, to: s.dest, color: s.brush })),
    };
    if (preview) v.previewing = { start: preview.start, moves: preview.plies.map((p) => p.san).join(" "), at: preview.idx + 1 };
    if (mode === "study") Object.assign(v, { sceneId: study.id, nodeId: study.node }, rep.on ? { rep: true, section: rep.section } : {});
    else if (mode === "play") { const g = pgame(); if (g) v.game = { id: g.id, playing: g.playing, color: g.color, moves: g.moves.length }; }
    else if (mode === "puzzle" && lp.on && lp.cur) v.lpuzzle = lpView(); // a Lichess puzzle (coach/lichess_puzzles.py)
    else if (pz.cur) v.puzzle = { id: pz.cur.id, attempts: pz.st.attempts, hinted: pz.st.hinted, solution: pz.st.solution };
    post("/api/view", v).catch(() => {});
  }, 120);
}

function setStatus(text, bad = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("bad", bad);
}

// ---------------- small shared pieces of the interface ----------------
// drawn icons (not characters: the iPad shows some of those as colour emoji)
const svg = (body, cls = "") => `<svg class="ico${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  dots: svg('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>', " fill"),
  spark: svg('<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>', " fill accent"),
  play: svg('<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>'),
  target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
};
// the ⋯ of a block: opens its menu (rare actions live there)
const dotsBtn = (id, label) => `<button type="button" class="ibtn" id="${id}" aria-label="${esc(label)}" title="${esc(label)}">${ICON.dots}</button>`;

// «?»: a short explanation opened by a tap (a touch screen has no hover), instead of paragraphs always on screen;
// an open one stays open when its panel renders again
const helpOpen = new Set();
const helpBtn = (key) => `<button type="button" class="help-btn" data-help="${key}" aria-expanded="${helpOpen.has(key)}" aria-label="Пояснение" title="Пояснение">?</button>`;
const helpText = (key, html) => `<div class="help-text" data-help-for="${key}"${helpOpen.has(key) ? "" : " hidden"}>${html}</div>`;
document.addEventListener("click", (e) => {
  const b = e.target.closest(".help-btn");
  if (!b) return;
  const k = b.dataset.help;
  const on = !helpOpen.has(k);
  if (on) helpOpen.add(k); else helpOpen.delete(k);
  for (const x of $$(`.help-btn[data-help="${k}"]`)) x.setAttribute("aria-expanded", String(on));
  for (const x of $$(`[data-help-for="${k}"]`)) x.hidden = !on;
});

// A menu under a button of the panel (⋯ of a section, «Сыграть», «Задачи», a filter…). Its buttons carry data-act and
// go to the handler given when it opened; a handler that returns true keeps it open (it showed something else in it,
// e.g. «Удалить?» — a delete always asks again inside its menu). The same button closes it again.
const pmenu = { on: null, anchor: null };
function placeMenu(el, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.right - w;
  if (left < 8) left = Math.min(r.left, innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
}
function openMenu(anchor, html, on) {
  const el = $("#pmenu");
  if (!el.hidden && pmenu.anchor === anchor.id) { closeMenu(); return; }
  el.innerHTML = html;
  el.hidden = false;
  pmenu.on = on;
  pmenu.anchor = anchor.id;
  placeMenu(el, anchor);
}
function setMenu(html) { // new content in the open menu
  const el = $("#pmenu");
  el.innerHTML = html;
  const a = pmenu.anchor && document.getElementById(pmenu.anchor);
  if (a) placeMenu(el, a);
}
function closeMenu() { $("#pmenu").hidden = true; pmenu.on = null; pmenu.anchor = null; }
const confirmHtml = (title, text, act, label) => `<div class="menu-confirm"><b>${title}</b>${text ? `<span>${text}</span>` : ""}
  <div class="actions"><button type="button" class="btn danger" data-act="${act}">${label}</button><button type="button" class="btn quiet" data-act="cancel">Отмена</button></div></div>`;
$("#pmenu").addEventListener("click", async (e) => {
  e.stopPropagation();
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  let keep = false;
  try { keep = await pmenu.on?.(b.dataset.act, b); } catch (err) { setStatus(String(err.message), true); }
  if (!keep) closeMenu();
});
$("#pmenu").addEventListener("submit", async (e) => {
  e.preventDefault();
  let keep = false;
  try { keep = await pmenu.on?.("submit", e.target); } catch (err) { setStatus(String(err.message), true); }
  if (!keep) closeMenu();
});
document.addEventListener("click", (e) => {
  if ($("#pmenu").hidden || e.target.closest("#pmenu") || (pmenu.anchor && e.target.closest(`[id="${pmenu.anchor}"]`))) return;
  closeMenu();
});

// =====================================================================
// PREVIEW — a line clicked in text, shown on the board without changing anything
// =====================================================================
let preview = null; // {start, plies, idx, title, nodeId?}

function openPreview(line, idx = 0, title = "Вариант") {
  if (!line?.plies?.length) return;
  const nums = numLabels(line.start, line.plies.length);
  preview = { start: line.start, plies: line.plies.map((p, i) => ({ ...p, num: p.num || nums[i] })), idx, title };
  renderPreview();
  renderBoard();
  reportView();
}

function closePreview() {
  if (!preview) return;
  preview = null;
  renderPreview();
  renderBoard();
  if (mode === "study") { renderStudyPanel(); requestEval(); } else renderPuzzlePanel(); // Stockfish was on the line's position
  renderEvalBar();
  reportView();
}

function closePreviewSilently() { if (preview) { preview = null; renderPreview(); } }

function previewStep(dir) {
  const n = preview.plies.length;
  preview.idx = { first: -1, last: n - 1, next: Math.min(preview.idx + 1, n - 1), prev: Math.max(preview.idx - 1, -1) }[dir];
  renderPreview();
  renderBoard();
  reportView();
}

function previewNode() {
  // the tree node whose position is the preview's start, so the line can be added there
  const sc = scene();
  if (mode !== "study" || !sc || !preview) return null;
  const k = fenKey(preview.start);
  const cur = curNode();
  if (cur && fenKey(cur.fen) === k) return cur;
  for (const { n } of tindex(sc).values()) if (fenKey(n.fen) === k) return n;
  return null;
}

function renderPreview() {
  const el = $("#preview");
  if (!preview) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const moves = preview.plies.map((p, i) =>
    `${p.num.endsWith(".") || i === 0 ? `<span class="num">${p.num}</span>` : ""}<button type="button" class="pm${i === preview.idx ? " on" : ""}" data-pi="${i}">${esc(p.san)}</button>`).join("");
  el.innerHTML = `<div class="preview-head"><span>${esc(preview.title)} · на доске</span>
      <span class="actions">
        ${previewNode() ? `<button type="button" class="btn small" id="pv-add" title="Добавить этот вариант в дерево">В дерево</button>` : ""}
        <button type="button" class="btn small" id="pv-close" title="Вернуться (Esc)">✕ Вернуться</button>
      </span></div>
    <div class="moves">${moves}</div>`;
}

$("#preview").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.pi !== undefined) { preview.idx = Number(b.dataset.pi); renderPreview(); renderBoard(); reportView(); }
  else if (b.id === "pv-close") closePreview();
  else if (b.id === "pv-add") {
    const at = previewNode();
    const upto = preview.plies.slice(0, Math.max(preview.idx + 1, 1));
    const sc = scene();
    closePreviewSilently();
    if (rep.on && sc?.rep) { // the repertoire keeps only moves chosen with «Записать в репертуар»: the line is tried first
      study.node = at.id;
      rep.trial = { scene: sc.id, base: at.id, ucis: upto.map((p) => p.uci) };
      renderStudy();
      return;
    }
    try {
      const r = await post("/api/scene/add", { scene: sc.id, at: at.id, moves: upto.map((p) => p.uci), goto: "end" });
      study.node = r.last.node;
      renderStudy();
    } catch (err) { setStatus(String(err.message), true); }
  }
});

// clicks on moves written in text
document.addEventListener("click", (e) => {
  const m = e.target.closest(".mvl");
  if (!m) return;
  const seq = m.closest(".mseq");
  const i = Number(m.dataset.i);
  if (seq.dataset.line) { openPreview(LINES.get(seq.dataset.line), i, "Вариант"); return; }
  const line = resolveSeq(seq);
  if (line?.scene) setScene(line.scene); // the line is about another board of this chat: that board comes on screen
  if (line?.nodes?.[i] && mode === "study") {
    closePreviewSilently();
    study.node = line.nodes[i].id;
    renderStudy();
    return;
  }
  if (!line) {
    m.classList.add("miss");
    m.title = "Этот ход нельзя сыграть ни в одной позиции досок этого чата";
    setTimeout(() => m.classList.remove("miss"), 1500);
    return;
  }
  if (line.way) { // Claude wrote the way to the line: from the board's start, to step through
    openPreview({ start: line.way.start, plies: [...line.way.before, ...line.plies] }, line.way.before.length + i, "Вариант из текста");
    return;
  }
  if (line.hist) { // a move of the game before the board: the game up to it, to step through
    openPreview({ start: line.hist.start, plies: [...line.hist.before, ...line.plies] }, line.hist.before.length + i, "Партия до этой доски");
    return;
  }
  openPreview(line, Math.min(i, line.plies.length - 1), line.threat ? `Угроза: если бы ходили ${turnOf(line.start) === "white" ? "белые" : "чёрные"}` : "Вариант из текста");
});

function parseTok(t) {
  const m = t.match(/^(\d+)(\.\.\.|…|\.)\s?(.*)$/);
  const san = (m ? m[3] : t).replace(/(!!|\?\?|!\?|\?!|!|\?)$/, "");
  const check = san.includes("#") ? "#" : san.includes("+") ? "+" : "";
  return m ? { num: Number(m[1]), black: m[2] !== ".", san, check } : { san, check };
}

function candidateFens() {
  const out = [];
  const add = (f) => { if (f && !out.includes(f)) out.push(f); };
  if (preview) { add(preview.start); preview.plies.forEach((p) => add(p.fen)); }
  add(shownFen);
  if (mode === "study") {
    const sc = scene();
    if (sc) {
      [sc.root, ...pathTo(sc, study.node)].reverse().forEach((n) => add(n.fen));
      for (const { n } of tindex(sc).values()) add(n.fen);
      const hist = histOf(sc);
      if (hist) [hist.start, ...hist.plies.map((p) => p.fen)].forEach(add);
    }
  } else if (pz.cur) {
    add(pz.cur.fen);
    (pz.st?.fens || []).forEach(add);
  }
  return out;
}

const normSan = (x) => x.replace(/[+#]/g, "").replace(/(!!|\?\?|!\?|\?!|!|\?)$/, "");
const toPly = (n) => ({ san: n.san, uci: n.uci, fen: n.fen, num: n.num });
function numFits(node, tok) {
  if (!tok.num || !node.num) return true;
  return parseInt(node.num, 10) === tok.num && node.num.endsWith(".") === !tok.black;
}

// play SAN tokens by the rules from `fen`; null if one is illegal
function playSan(fen, toks) {
  const c = new Chess(fen);
  const ucis = [];
  for (const t of toks) {
    try { const mv = c.move(t.san); ucis.push(mv.from + mv.to + (mv.promotion || "")); } catch { return null; }
    if (t.check === "+" && !c.inCheck()) return null; // "Ne7+" must really give check
    if (t.check === "#" && !c.isCheckmate()) return null;
  }
  return playLine(fen, ucis).plies;
}

// moves that are already in the move tree on screen (or of the board `other`): follow the tree (current path and main line first).
// `prefer` (position key -> rank, lower is better): only a line that starts from one of those positions, the best rank wins
function treeMatch(toks, other = null, prefer = null) {
  const sc = other || (mode === "study" ? scene() : null);
  const root = sc ? sc.root : mode === "study" ? null : pz.st?.tree;
  if (!root) return null;
  const parent = new Map();
  const order = [];
  const seen = new Set();
  const push = (n) => { if (n && !seen.has(n.id)) { seen.add(n.id); order.push(n); } };
  const walk = (n) => n.children.forEach((c) => { parent.set(c.id, n); walk(c); });
  walk(root);
  if (sc && !other) pathTo(sc, study.node).forEach(push);
  for (let n = root.children[0]; n; n = n.children[0]) push(n);
  const all = (n) => n.children.forEach((c) => { push(c); all(c); });
  all(root);
  let best = null;
  for (const n of order) {
    if (normSan(n.san) !== normSan(toks[0].san) || !numFits(n, toks[0])) continue;
    const start = parent.get(n.id).fen;
    const rank = prefer ? prefer.get(fenKey(start)) : 0;
    if (rank === undefined || (best && rank >= best.rank)) continue;
    const nodes = [n];
    let cur = n;
    for (const t of toks.slice(1)) {
      const next = cur.children.find((c) => normSan(c.san) === normSan(t.san));
      if (!next) break;
      nodes.push(next);
      cur = next;
    }
    let line = null;
    if (nodes.length === toks.length) line = { start, plies: nodes.map(toPly), nodes, full: true };
    else {
      const rest = playSan(cur.fen, toks.slice(nodes.length)); // partly in the tree: continue by the rules
      if (rest) line = { start, plies: [...nodes.map(toPly), ...rest], nodes, full: false };
    }
    if (!line) continue;
    if (!prefer) return line;
    best = { rank, line };
  }
  return best?.line || null;
}

// ---------------- a line with its way, written by Claude ----------------
// [3...Bf5](#1.d4 d5 2.c4 dxc4 3.e3): Claude writes the moves that lead to a line in a hidden part, so the app knows
// the line for sure and does not guess. The way is played from the start of a board of this chat (the one on screen
// first), from the first move of the game before that board, or from the initial position; every move number in it
// must fit. null when it fits none of them (a slip of Claude's): then the line is guessed as for plain text.
function wayStarts() {
  const out = [];
  const add = (fen, sc) => { if (fen && !out.some((x) => x.fen === fen)) out.push({ fen, sc }); };
  if (mode === "study") {
    for (const sc of [scene(), ...boardsOf(ch.cur).reverse()]) if (sc) { add(sc.root.fen, sc); add(histOf(sc)?.start, sc); }
  } else if (pz.cur) add(pz.cur.fen, null);
  add(START_FEN, null);
  return out;
}

function wayLine(wayText, toks) {
  const way = (wayText.match(TOK_RE) || []).map(parseTok);
  const all = [...way, ...toks];
  for (const { fen, sc } of wayStarts()) {
    const plies = playSan(fen, all);
    if (!plies || all.some((t, k) => t.num && !numFen(t)(k ? plies[k - 1].fen : fen))) continue;
    const before = plies.slice(0, way.length);
    const line = { start: before.at(-1)?.fen || fen, plies: plies.slice(way.length), way: { start: fen, before } };
    if (sc && sc !== scene()) line.scene = sc.id;
    // the moves that are in that board's tree: a click goes there
    const root = sc ? sc.root : mode === "puzzle" ? pz.st?.tree : null;
    const fens = [fen, ...plies.map((p) => p.fen)];
    const j = root ? fens.findIndex((f) => fenKey(f) === fenKey(root.fen)) : -1;
    if (j >= 0) {
      line.nodes = [];
      for (let p = j, cur = root; p < plies.length && (cur = cur.children.find((c) => c.uci === plies[p].uci)); p++) {
        if (p >= way.length) line.nodes[p - way.length] = cur;
      }
    }
    return line;
  }
  return null;
}

// ---------------- a line read in the light of the text before it ----------------
// "after 2...dxc4 3.e3 you played 3...Bf5 twice": 3...Bf5 goes on from 2...dxc4 3.e3, not from another position with
// black's 3rd move somewhere in the tree (a click showed 3...Bf5 in the London). So a line is looked for first from
// the positions of the lines written just before it: in the same comment, or in the same reply of Claude (its parts
// between tool calls count as one); the nearest line first, its last position first.
function linesBefore(seq) {
  const ai = seq.closest(".msg-ai");
  const parts = [];
  if (ai) {
    for (let el = ai; el && !el.classList.contains("msg-user"); el = el.previousElementSibling) {
      if (el.classList.contains("msg-ai")) parts.unshift(el);
    }
  } else parts.push(seq.closest(".rich") || seq.parentElement);
  const all = parts.flatMap((el) => $$(".mseq", el));
  return all.slice(0, all.indexOf(seq)).reverse();
}

// how: "tree" — only moves of the tree that start from a position of a line before; "rules" — only by the rules from
// such a position; "both" — whichever starts nearer the end of that line
function inContext(seq, toks, how) {
  const fits = numFen(toks[0]) || (() => true);
  let looked = 0;
  for (const prev of linesBefore(seq)) {
    const ctx = textLine(prev);
    if (!ctx?.plies?.length) continue;
    const way = ctx.way ? [ctx.way.start, ...ctx.way.before.map((p) => p.fen)] : [];
    const fens = [...new Set([...way, ctx.start, ...ctx.plies.map((p) => p.fen)])].reverse();
    const prefer = new Map();
    fens.forEach((f, i) => { if (!prefer.has(fenKey(f))) prefer.set(fenKey(f), i); });
    const board = ctx.scene ? study.scenes.find((s) => s.id === ctx.scene) : null; // a line about another board of this chat
    const inTree = how !== "rules" ? treeMatch(toks, board, prefer) : null;
    const rank = inTree ? prefer.get(fenKey(inTree.start)) : Infinity;
    for (const [i, fen] of (how !== "tree" ? fens : []).entries()) { // by the rules: the moves are not in the tree (yet)
      if (i >= rank) break;
      const plies = fits(fen) && playSan(fen, toks);
      if (plies?.length) return { start: fen, plies, ...(ctx.scene && { scene: ctx.scene }) };
    }
    if (inTree) return ctx.scene ? { ...inTree, scene: ctx.scene } : inTree;
    if (++looked === 3) break;
  }
  return null;
}

// a line written in text, read without guessing from the board: by the way Claude wrote for it (wayLine), else from
// the lines before it in the text, the move tree,
// the game before the board, the tree of another board of this chat. A numbered move ("3...Bf5") is read from the
// text before it first; an unnumbered one ("Qb3") fits too many positions, so there the tree comes before the rules.
// Cached per tree; `fresh`: read again (a click — the current path in the tree counts)
function textLine(seq, fresh = false) {
  if (seq.dataset.line) return LINES.get(seq.dataset.line) || null;
  const tree = mode === "study" ? scene() : pz.st?.tree;
  if (!fresh && seq._tl && seq._tl.tree === tree && seq._tl.mode === mode) return seq._tl.line;
  const toks = $$(".mvl", seq).map((x) => parseTok(x.textContent));
  const num = !!toks[0].num;
  const line = (seq.dataset.way !== undefined && wayLine(seq.dataset.way, toks)) || inContext(seq, toks, num ? "both" : "tree") || treeMatch(toks) || (mode === "study" && histMatch(toks, scene()))
    || otherBoard(toks, true) || (!num && inContext(seq, toks, "rules")) || null;
  seq._tl = { tree, mode, line };
  return line;
}

// a line written in text (the `.mseq` element), in order: the lines before it in the text, the tree on screen, the tree
// of another board of this chat, the rules from a position on screen, the rules from a position of another board of
// this chat (the moves that led to a board's start count as its tree)
function resolveSeq(seq) {
  const toks = $$(".mvl", seq).map((x) => parseTok(x.textContent));
  return textLine(seq, true) || byRules(toks) || otherBoard(toks, false);
}

// ---------------- the moves that led to a board's start ----------------
// "after 5...Bg7 the knight d4 hangs" about a board that starts after 5...Bg7: the server keeps those moves with the
// board (sc.history: from the moves Claude gave, or from the user's game that reaches the position, coach/history.py)
const histCache = new WeakMap();
function histOf(sc) {
  if (!sc?.history?.moves?.length) return null;
  let h = histCache.get(sc);
  if (!h) { h = playLine(sc.history.start, sc.history.moves); histCache.set(sc, h); }
  return h.plies.length === sc.history.moves.length ? h : null;
}

// moves of the game before the board, maybe going on into the tree or by the rules:
// {start, plies, nodes (nodes[k]: the tree node of toks[k], the start for the move into it), hist: {start, before}}
function histMatch(toks, sc) {
  const hist = histOf(sc);
  if (!hist) return null;
  const hp = hist.plies;
  for (let h = 0; h < hp.length; h++) {
    if (normSan(hp[h].san) !== normSan(toks[0].san) || !numFits(hp[h], toks[0])) continue;
    const plies = [];
    const nodes = [];
    let k = 0;
    while (k < toks.length && h + k < hp.length && normSan(hp[h + k].san) === normSan(toks[k].san)) plies.push(hp[h + k++]);
    let fen = plies.at(-1).fen;
    if (h + k === hp.length) { // reached the board's start: on into its tree
      nodes[k - 1] = sc.root;
      for (let cur = sc.root, next; k < toks.length && (next = cur.children.find((c) => normSan(c.san) === normSan(toks[k].san))); k++) {
        nodes[k] = next;
        plies.push(toPly(next));
        cur = next;
        fen = next.fen;
      }
    }
    const rest = k < toks.length ? playSan(fen, toks.slice(k)) : [];
    if (!rest) continue;
    return { start: h ? hp[h - 1].fen : hist.start, plies: [...plies, ...rest], nodes, hist: { start: hist.start, before: hp.slice(0, h) } };
  }
  return null;
}

// a chat has several boards: a line from an earlier message may belong to another of them (`scene` says which)
function otherBoard(toks, treeOnly) {
  if (mode !== "study") return null;
  const fits = numFen(toks[0]);
  for (const sc of boardsOf(ch.cur).reverse()) {
    if (sc.id === study.id) continue;
    if (treeOnly) {
      const inTree = treeMatch(toks, sc) || histMatch(toks, sc);
      if (inTree) return { ...inTree, scene: sc.id };
    } else if (fits) { // an unnumbered move fits too many positions of a board not on screen
      const hist = histOf(sc);
      const fens = [...tindex(sc).values()].map(({ n }) => n.fen);
      if (hist) fens.push(hist.start, ...hist.plies.map((p) => p.fen));
      for (const fen of fens) {
        const plies = fits(fen) && playSan(fen, toks);
        if (plies?.length) return { start: fen, plies, scene: sc.id };
      }
    }
  }
  return null;
}

// a numbered first move ("12...Nf6") fits only positions with that move number and side to move
const numFen = (first) => (first.num ? (f) => { const [, side, , , , full] = f.split(" "); return Number(full) === first.num && (side === "b") === first.black; } : null);

function byRules(toks) {
  const first = toks[0];
  let cands;
  if (first.num) {
    cands = candidateFens().filter(numFen(first));
  } else {
    cands = [shownFen, ...(mode === "puzzle" && pz.cur ? [pz.cur.fen] : [])];
  }
  for (const fen of cands) {
    const plies = playSan(fen, toks);
    if (plies?.length) return { start: fen, plies };
  }
  // a threat: an unnumbered move of the side that is not to move, from the board or a position of the tree
  if (!first.num) {
    const bases = [shownFen];
    const sc = mode === "study" ? scene() : null;
    if (sc) {
      [sc.root, ...pathTo(sc, study.node)].reverse().forEach((n) => bases.push(n.fen));
      for (const { n } of tindex(sc).values()) bases.push(n.fen);
    } else if (pz.cur) bases.push(pz.cur.fen, ...(pz.st?.fens || []));
    for (const base of [...new Set(bases)]) {
      const flipped = passTurn(base);
      const plies = flipped && playSan(flipped, toks);
      if (plies?.length) return { start: flipped, plies, threat: true, base };
    }
  }
  return null;
}

// the same position with the other side to move (null move); null when the side to move is in check
function passTurn(fen) {
  if (new Chess(fen).inCheck()) return null;
  const f = fen.split(" ");
  f[1] = f[1] === "w" ? "b" : "w";
  f[3] = "-";
  return f.join(" ");
}

// ---------------- hover: a small board for a move in text, an arrow when the move is playable on the board ----------------
const hov = { el: $("#hoverboard"), cg: null, target: null, temp: null, timer: null };
hov.cg = Chessground($("#hb"), { viewOnly: true, coordinates: false, animation: { enabled: false }, drawable: { enabled: false, visible: true } });

function hoverLine(t) {
  if (t.classList.contains("pvm")) {
    const l = ceval.res?.lines?.[Number(t.dataset.pv)];
    return l ? { line: playLine(ceval.res.fen, l.uci), i: Number(t.dataset.i) } : null;
  }
  const seq = t.closest(".mseq");
  if (!seq) return null;
  const i = Number(t.dataset.i);
  if (seq.dataset.line) { const line = LINES.get(seq.dataset.line); return line ? { line, i } : null; }
  const line = resolveSeq(seq);
  return line ? { line, i: Math.min(i, line.plies.length - 1) } : null;
}

// shapes shown only while hovering; removed again without touching the board's own shapes
function tempShapes(shapes) {
  clearTempArrow();
  hov.temp = shapes;
  setAutoShapes([...cg.state.drawable.autoShapes, ...shapes]);
}
function tempArrow(uci, brush = "blue") {
  tempShapes([{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush, modifiers: { lineWidth: 12 } }]);
}
function clearTempArrow() {
  if (!hov.temp) return;
  const gone = new Set(hov.temp);
  setAutoShapes(cg.state.drawable.autoShapes.filter((x) => !gone.has(x)));
  hov.temp = null;
}

function showHover(t) {
  hov.target = t;
  if (t.dataset.arrow) { tempArrow(t.dataset.arrow, t.dataset.brush || "blue"); return; }
  if (t.dataset.sqs) { lightSquares(t.dataset.sqs.split(",")); return; }
  const r = hoverLine(t);
  const ply = r?.line?.plies?.[r.i];
  if (!ply) return;
  // the move can be played from what the board shows: draw it there too
  const before = r.i === 0 ? r.line.start : r.line.plies[r.i - 1].fen;
  if (fenKey(before) === fenKey(shownFen)) tempArrow(ply.uci);
  else if (r.line.threat && r.i === 0 && fenKey(r.line.base) === fenKey(shownFen)) tempArrow(ply.uci, "red");
  hov.cg.set({ fen: ply.fen, orientation: t.closest("[data-side]")?.dataset.side || cg.state.orientation, lastMove: sq(ply.uci), check: new Chess(ply.fen).inCheck() ? turnOf(ply.fen) : false });
  const rect = t.getBoundingClientRect();
  const W = Math.min(320, innerWidth - 16, innerHeight - 16); // smaller on a narrow screen
  hov.el.style.width = hov.el.style.height = `${W}px`;
  const x = Math.min(Math.max(8, rect.left - 20), innerWidth - W - 8);
  let y = rect.bottom + 8;
  if (y + W > innerHeight - 8) y = rect.top - W - 8;
  hov.el.style.left = `${x}px`;
  hov.el.style.top = `${Math.max(8, y)}px`;
  hov.el.hidden = false;
  hov.cg.redrawAll();
}

const LIT = '<rect x="0" y="0" width="100" height="100" fill="#ffbe00" fill-opacity="0.5"/>';
function lightSquares(keys) {
  tempShapes(keys.map((k) => ({ orig: k, customSvg: { html: LIT }, below: true })));
}

function hideHover() {
  clearTimeout(hov.timer);
  hov.target = null;
  hov.el.hidden = true;
  clearTempArrow();
}

const HOVERABLE = ".mvl, .pvm, [data-arrow], .sqr";
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest(HOVERABLE);
  if (!t || t === hov.target) return;
  hideHover();
  hov.target = t;
  hov.timer = setTimeout(() => { if (hov.target === t) showHover(t); }, 60);
});
document.addEventListener("mouseout", (e) => {
  const t = e.target.closest(HOVERABLE);
  if (t && t === hov.target && !t.contains(e.relatedTarget)) hideHover();
});
document.addEventListener("mousedown", hideHover);

// ---------------- the move on the board, highlighted in text ----------------
// a written line counts when it is an engine line, in the move tree on screen, or goes on from a line before it in
// the text — not a guess from the board (textLine, cached per tree)
function seqLine(seq) {
  if (seq.dataset.line) return LINES.get(seq.dataset.line) || null;
  if (!(mode === "study" ? scene() : pz.st?.tree)) return null;
  const line = textLine(seq);
  return line && !line.scene ? line : null;
}

// The line on the board, as position keys: the tree from its root to the position shown and on along its main line
// (where → goes), with the game's moves before the board; a previewed line from text or a tried line replaces the
// tree after the node it starts from. Its moves get a frame in text, so every place that refers to it stands out.
// None during the repertoire drill: the frame would give away the moves to play from memory.
function boardLineKeys() {
  const keys = new Set();
  if (rep.drill || rep.game) return keys;
  const sc = mode === "study" ? scene() : null;
  const root = sc ? sc.root : mode === "puzzle" ? pz.st?.tree : null;
  const fromRoot = (hit) => { // the nodes from the root to the first node `hit` accepts (main line first)
    const walk = (n) => {
      if (hit(n)) return [n];
      for (const c of n.children) { const r = walk(c); if (r) return [n, ...r]; }
      return null;
    };
    return root ? walk(root) || [] : [];
  };
  const tried = sc && rep.on ? repTrial() : null;
  let nodes, after = [];
  if (preview) {
    const k = fenKey(preview.start);
    nodes = fromRoot((n) => fenKey(n.fen) === k);
    after = [{ fen: preview.start }, ...preview.plies];
  } else if (tried) {
    nodes = fromRoot((n) => n === tried.base);
    after = tried.plies;
  } else {
    const cur = sc ? curNode() : null, k = fenKey(shownFen);
    nodes = fromRoot(cur ? (n) => n === cur : (n) => fenKey(n.fen) === k);
    for (let n = nodes.at(-1)?.children[0]; n; n = n.children[0]) nodes.push(n);
  }
  if (sc && nodes[0] === root) histOf(sc)?.plies.forEach((p) => keys.add(fenKey(p.fen)));
  for (const x of [...nodes, ...after]) keys.add(fenKey(x.fen));
  return keys;
}

function highlightMoves() {
  const key = fenKey(shownFen);
  const onLine = boardLineKeys();
  for (const seq of $$(".mseq")) {
    if (seq.dataset.nf !== undefined) continue; // lists of lines (the repertoire's): no frames, they would be on every row
    const line = seqLine(seq);
    const flags = $$(".mvl", seq).map((t, i) => {
      const k = line?.plies?.[i] ? fenKey(line.plies[i].fen) : null;
      t.classList.toggle("on", !!k && k === key);
      return !!k && (k === key || onLine.has(k));
    });
    frameRuns(seq, flags);
  }
}

// One frame around each run of moves in a row of text that are on the board's line. The frame is a span put around
// the run; the DOM changes only when the runs change, so the next pass after it (the observer below) does nothing.
function frameRuns(seq, flags) {
  const sig = flags.map(Number).join("");
  if ((seq.dataset.runs ?? flags.map(() => 0).join("")) === sig) return;
  seq.dataset.runs = sig;
  for (const r of $$(":scope > .lrun", seq)) r.replaceWith(...r.childNodes);
  const moves = $$(".mvl", seq);
  for (let i = 0; i < moves.length; i++) {
    if (!flags[i]) continue;
    let j = i;
    while (flags[j + 1]) j++;
    const range = document.createRange();
    range.setStartBefore(moves[i]);
    range.setEndAfter(moves[j]);
    const prev = moves[i].previousSibling; // "25." written before the move (lines from explanations) goes in too
    const num = prev?.nodeType === Node.TEXT_NODE ? prev.data.match(/\d+(?:\.\.\.|…|\.)$/) : null;
    if (num) range.setStart(prev, num.index);
    const box = document.createElement("span");
    box.className = "lrun";
    range.surroundContents(box);
    i = j;
  }
}

let hlFrame = null;
function scheduleHighlight() {
  if (hlFrame) return;
  hlFrame = requestAnimationFrame(() => { hlFrame = null; highlightMoves(); });
}
// new text in the chat or the panel: highlight there too (class changes are not observed, so no loop)
for (const id of ["#chat-log", "#panel", "#preview"]) {
  new MutationObserver(scheduleHighlight).observe($(id), { childList: true, subtree: true, characterData: true });
}

// =====================================================================
// STUDY — Lichess-style analysis with a move tree
// =====================================================================
const study = { scenes: [], id: null, node: "root", flipped: false, engine: false, newpos: false, chatBoard: {} };
// «Репертуар» (the REPERTOIRE section below): on = the repertoire is on screen; data = sections and lessons
const rep = { on: false, data: { sections: [], lessons: {}, drill: {} }, section: null, color: "white", form: false, rename: false, del: false, trial: null, drill: null, games: null, gamesOpen: false, after: {}, delLesson: null, game: null };
const scene = () => study.scenes.find((s) => s.id === study.id) || null;

const idxCache = new WeakMap();
function tindex(sc) {
  let m = idxCache.get(sc);
  if (!m) {
    m = new Map();
    const walk = (n, p) => { m.set(n.id, { n, p }); n.children.forEach((c) => walk(c, n)); };
    walk(sc.root, null);
    idxCache.set(sc, m);
  }
  return m;
}
function curNode() { const sc = scene(); return sc ? (tindex(sc).get(study.node)?.n || sc.root) : null; }
function pathTo(sc, id) {
  const ix = tindex(sc);
  const out = [];
  let e = ix.get(id);
  while (e && e.p) { out.push(e.n); e = ix.get(e.p.id); }
  return out.reverse();
}

function studyBoard() {
  if (repGameBoard() || repDrillBoard() || repTrialBoard()) return; // the repertoire drill, or a line being tried on a repertoire tree (REPERTOIRE)
  const node = curNode();
  const fen = node ? node.fen : START_FEN;
  const into = node && node === scene()?.root ? histOf(scene())?.plies.at(-1) : null; // the game's move into the board's start
  setBoard({
    fen, orientation: boardOrientation(), lastMove: node?.uci ? sq(node.uci) : into ? sq(into.uci) : undefined,
    shapes: [...(node?.shapes || []), ...glyphShape(node), ...engineArrow(fen)],
    movable: { color: turnOf(fen), dests: legalDests(fen), after: onStudyMove },
  });
}

async function onStudyMove(orig, dest) {
  let promotion = "q";
  if (isPromotion(shownFen, orig, dest)) {
    promotion = await choosePromotion(dest, turnOf(shownFen));
    if (!promotion) { renderStudy(); return; }
  }
  const c = new Chess(shownFen);
  let m;
  try { m = c.move({ from: orig, to: dest, promotion }); } catch { renderStudy(); return; }
  const uci = m.from + m.to + (m.promotion || "");
  if (rep.on && (repGameMove(uci) || repDrillMove(uci) || (scene()?.rep && repTry(uci)))) return; // the drill's answer; on the repertoire a new move is only tried
  try {
    let sc = scene();
    if (!sc) {
      const r = await post("/api/scene", { title: "Свободный анализ", position: START_FEN, chat: claimChat() });
      await waitScene(r.scene);
      study.id = r.scene;
      study.node = "root";
      sc = scene();
    }
    const node = curNode();
    const child = node.children.find((x) => x.uci === uci);
    if (child) { study.node = child.id; renderStudy(); return; }
    const r = await post("/api/scene/move", { scene: sc.id, at: node.id, uci, client: CLIENT });
    upsertScene(r.scene);
    study.node = r.node;
    renderStudy();
    scheduleAsk();
  } catch (err) { setStatus(String(err.message), true); renderStudy(); }
}

// ---- the user's own move = "calculate this line for me" ----
let askTimer = null;
// automatic only where there is something to discuss: a diagram Claude made, or a puzzle position
const discussed = (sc) => !!(sc && (sc.chat || sc.puzzle));
function scheduleAsk() {
  clearTimeout(askTimer);
  if (!study.autoAsk || !discussed(scene())) return;
  askTimer = setTimeout(askAboutUserLine, 1500);
}

function moveText(nodes) {
  return nodes.map((n, i) => (n.num.endsWith(".") || i === 0 ? n.num : "") + n.san).join(" ");
}

function askAboutUserLine() {
  const sc = scene();
  const node = curNode();
  if (!sc || !node || node.by !== "user") return;
  const path = pathTo(sc, node.id);
  let k = path.length;
  while (k > 0 && path[k - 1].by === "user") k--; // the user's own moves at the end of the path
  const mine = path.slice(k);
  const before = path.slice(0, k);
  const where = before.length ? `после ${moveText(before)}` : "из начальной позиции диаграммы";
  // While Claude is busy the question waits; a further move on the same line replaces it (the server swaps a waiting
  // message whose key is in `supersedes`), so a line played move by move gets one answer, not one per move.
  const key = (n) => `ask:${sc.id}:${n.id}`;
  sendToChat(
    `Мой вариант: ${moveText(mine)} (${where}; доска «${sc.title}» ${sc.id}, узел ${node.id}).\n` +
    "Посчитай его движком и разбери: коротко в чате и на доске — комментарий и стрелки к моему ходу, " +
    "лучший ответ соперника веткой из этого узла, и если мой ход хуже — какой был лучше. " +
    "Ходы этого варианта, которые ты уже разобрал выше, не повторяй и их комментарии не переписывай — разбери только новые.",
    sc,
    { key: key(node), supersedes: path.map(key) },
  );
}
function waitScene(id) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (study.scenes.some((s) => s.id === id) || Date.now() - t0 > 3000 ? resolve() : setTimeout(tick, 30));
    tick();
  });
}

function studyStep(dir) {
  if (rep.on && (rep.drill || rep.game || repTrialStep(dir))) return; // no stepping through the moves during the drill
  const sc = scene();
  if (!sc) return;
  const e = tindex(sc).get(study.node) || { n: sc.root, p: null };
  if (dir === "prev" && e.p) study.node = e.p.id;
  else if (dir === "next" && e.n.children[0]) study.node = e.n.children[0].id;
  else if (dir === "first") study.node = "root";
  else if (dir === "last") { let n = e.n; while (n.children[0]) n = n.children[0]; study.node = n.id; }
  else if ((dir === "up" || dir === "down") && e.p) {
    const sib = e.p.children;
    const j = (sib.indexOf(e.n) + (dir === "down" ? 1 : -1) + sib.length) % sib.length;
    study.node = sib[j].id;
  }
  renderStudy();
}

function setScene(id, node = "root") {
  study.id = id;
  study.node = node;
  study.flipped = false;
  closePreviewSilently();
  renderStudy();
  followBoard();
}

// ---- a chat and its boards: a board keeps its chat's id (sc.chat), a chat may have several boards, each with its own tree.
// In «Разбор» the chat panel shows the chat of the board on screen; opening a chat brings its active board (the one of
// that chat last on screen or made last: study.chatBoard, kept by the server), and tabs above the tree switch boards. ----
const chatOf = (sc) => (sc?.chat && ch.list.some((c) => c.id === sc.chat) ? sc.chat : null);
const boardsOf = (cid) => (cid ? study.scenes.filter((s) => s.chat === cid) : []);
function activeBoard(cid) {
  const own = boardsOf(cid);
  return own.find((s) => s.id === study.chatBoard[cid]) || own.at(-1) || null;
}
// a board made while a chat is open is one more board of that chat
const claimChat = () => (ch.list.some((c) => c.id === ch.cur) ? ch.cur : undefined);

function followBoard() {
  if (mode !== "study" || isLive()) return;
  if (rep.on) { repFollowBoard(); return; }
  const cid = chatOf(scene());
  if (cid !== ch.cur) openChat(cid, { follow: false });
  else if (!cid) renderChatLog(); // its empty state names the board
}

function followChat() {
  if (mode !== "study" || isLive()) return;
  if (rep.on) { repFollowChat(); return; }
  const id = activeBoard(ch.cur)?.id ?? null;
  if (id === study.id) return;
  study.id = id;
  study.node = "root";
  study.flipped = false;
  closePreviewSilently();
  renderStudy();
}

// ---- tree view (also used for puzzle solutions) ----
const glyphHtml = (n) => (n.glyph ? `<span class="g ${GLYPH_CLASS[n.glyph] || ""}">${esc(n.glyph)}</span>` : "");
const labelHtml = (n) => (n.label ? `<span class="lbl">${esc(n.label)}</span>` : "");
function idxCell(num) { return `<span class="ix">${esc(num.replace(/[.…]$/, ""))}</span>`; }
// The tree's moves on the line of the current move: from the start to it and on along the main line (where → goes).
// In the branches' rows they get a frame, one per run as in text, so the way to the current move stands out; the main
// line's table gets none, it is one line anyway (set while a tree renders).
let treeLine = null;
function lineIds(root, cur) {
  const ids = new Set();
  let at = null;
  const walk = (n) => {
    if (n.id === cur) { at = n; return true; }
    for (const c of n.children) if (walk(c)) { ids.add(c.id); return true; }
    return false;
  };
  if (!walk(root)) return ids;
  ids.delete(cur);
  if (rep.trial?.base !== cur) for (let n = at.children[0]; n; n = n.children[0]) ids.add(n.id); // a tried line goes elsewhere
  return ids;
}
// the ⋯ of the current move: its menu without a right click (set only while a board's own tree renders)
let menuAt = null;
// labels on moves of a repertoire tree: the sections that start there and the places the user's games left the
// preparation (nodeId -> html; set only while a section's tree renders)
let repTags = null;
const tagsHtml = (n) => repTags?.get(n.id) || "";
const menuBtn = (n) => (n.id === menuAt
  ? `<button type="button" class="mv-menu" data-menu="${n.id}" aria-label="Действия с ходом" title="Действия с ходом"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>`
  : "");
function treeMove(n, cur) {
  return `<span class="tm${n.id === cur ? " active" : ""}${n.by === "user" ? " user" : ""}" data-id="${n.id}">${esc(n.san)}${glyphHtml(n)}${labelHtml(n)}${menuBtn(n)}</span>`;
}
function moveHtml(n, cur, force) { // the number (when due) and the move
  const num = n.num.endsWith(".") || force ? `<span class="num">${esc(n.num)}</span>` : "";
  return `${num}<span class="vm${n.id === cur ? " active" : ""}${n.by === "user" ? " user" : ""}" data-id="${n.id}">${esc(n.san)}${glyphHtml(n)}${menuBtn(n)}</span>`;
}
function inlineMove(n, cur, force) {
  return `${moveHtml(n, cur, force)}${labelHtml(n)}${askHtml(n)} `;
}
// A branch's row written piece by piece, with a frame around each run of moves of the line (treeLine): a title, a
// comment, a side line or branches end the run. `space`: the row goes on after a move written before it; `lead`:
// that move's run is open, and the row's first moves, if they are on the line too, go on in the same frame.
function rowHtml(cur, { space = false, lead = false } = {}) {
  let h = "", open = false;
  const sp = () => { if (space) h += " "; space = false; };
  const close = () => { if (open) h += "</span>"; open = false; };
  return {
    move(n, force) {
      const on = n.id === cur || !!treeLine?.has(n.id);
      if (on && lead && !h) { h += '<span class="lrun cont-l">'; open = true; }
      else if (!(on && open)) { close(); sp(); if (on) { h += '<span class="lrun">'; open = true; } }
      sp();
      h += moveHtml(n, cur, force);
      const after = labelHtml(n) + askHtml(n) + tagsHtml(n);
      if (after) { close(); h += after; }
      space = true;
    },
    add(html, spaceAfter = false) { close(); sp(); h += html; space = spaceAfter; },
    get open() { return open; },
    end(trailing = true) { close(); if (trailing) sp(); return h; },
  };
}
// «Спросить Claude» right after the user's move on screen, where the played line is (set only while the board's tree renders)
let askAt = null;
const askHtml = (n) => (n.id === askAt
  ? `<button type="button" class="ask-inline" id="ask-line" title="Один вопрос Claude про все твои ходы подряд до этого хода">Спросить Claude</button>`
  : "");
function commentHtml(n, cur) {
  return n.comment ? `<span class="cmt rich${n.id === cur ? " active-c" : ""}">${md(n.comment)}</span>` : "";
}

// Folded branches, per tree (a board by its id, other trees by their start position), kept across
// restarts. A folded branch shows only its first move; stepping onto a move inside it opens it again.
const FOLDED = (() => { try { return JSON.parse(localStorage.getItem("tree.folded") || "{}"); } catch { return {}; } })();
const foldShown = new Map(); // tree → the move that was current at its last render
let fold = null; // the tree being rendered: {key, set, moved, dirty}
const foldSet = (key) => new Set(FOLDED[key] || []);
function saveFold(key, set) {
  if (set.size) FOLDED[key] = [...set]; else delete FOLDED[key];
  const keys = Object.keys(FOLDED);
  if (keys.length > 300) delete FOLDED[keys[0]];
  try { localStorage.setItem("tree.folded", JSON.stringify(FOLDED)); } catch {}
}
const hasNode = (n, id) => n.children.some((c) => c.id === id || hasNode(c, id));
const countNodes = (n) => n.children.reduce((k, c) => k + 1 + countNodes(c), 0);
function plural(k, one, few, many) {
  const a = k % 10, b = k % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}
function setFolded(line, set, on) {
  line.classList.toggle("folded", on);
  line.querySelector(":scope > .tg")?.setAttribute("aria-expanded", String(!on));
  if (on) set.add(line.dataset.fold); else set.delete(line.dataset.fold);
}
// fold or open every branch of a tree view (right-click menu)
function foldAll(tv, on) {
  if (!tv) return;
  const set = foldSet(tv.dataset.tree);
  for (const l of $$(".line[data-fold]", tv)) setFolded(l, set, on);
  saveFold(tv.dataset.tree, set);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".tview .tg, .tview .more");
  if (!b) return;
  const line = b.closest(".line"), key = b.closest(".tview").dataset.tree;
  const set = foldSet(key);
  setFolded(line, set, !line.classList.contains("folded"));
  saveFold(key, set);
});

// A side line goes in parentheses (Lichess "renderInlined") only when it is short and plain: the only
// alternative, no forks, no comments, no title. Any other fork ends the row, and every branch — the
// main continuation first — gets its own indented row with a tree connector (Lichess "lines").
function plainLine(n, max = 8) {
  for (let i = 0; n; i++, n = n.children[0]) {
    if (i >= max || n.comment || n.label || n.children.length > 1) return false;
  }
  return true;
}
function lineHtml(n, cur) {
  const first = rowHtml(cur);
  first.move(n, true);
  const lead = first.open;
  const body = seqHtml(n, cur, true, lead);
  let head = first.end(false);
  // the first move stays outside the row's body (a folded branch shows only it): its frame and the body's join up
  if (lead && body.startsWith('<span class="lrun cont-l">')) head = head.replace('class="lrun"', 'class="lrun cont-r"');
  if (!body.trim()) return `<div class="line">${head}</div>`;
  let folded = !!fold?.set.has(n.id);
  if (folded && fold.moved && hasNode(n, cur)) { fold.set.delete(n.id); fold.dirty = true; folded = false; }
  const k = countNodes(n);
  const more = k ? `ещё ${k} ${plural(k, "ход", "хода", "ходов")}` : "комментарий";
  return `<div class="line${folded ? " folded" : ""}" data-fold="${n.id}">` +
    `<button type="button" class="tg" aria-expanded="${!folded}" title="Свернуть или развернуть вариант"></button>` +
    `${head}<button type="button" class="more" title="Развернуть вариант">… ${more}</button><span class="body">${body}</span></div>`;
}
function linesHtml(nodes, cur) {
  return `<div class="lines">${nodes.map((n) => lineHtml(n, cur)).join("")}</div>`;
}
// the moves from `first` on; with `rest`, everything after the first move (its comment included); `lead`: see rowHtml
function seqHtml(first, cur, rest = false, lead = false) {
  const row = rowHtml(cur, { space: rest, lead });
  if (!rest) row.move(first, true);
  if (first.comment) row.add(commentHtml(first, cur));
  let n = first;
  let force = !!first.comment;
  while (n.children.length) {
    const [main, ...alts] = n.children;
    if (alts.length > 1 || (alts.length && !plainLine(alts[0]))) { row.add(linesHtml(n.children, cur)); return row.end(); }
    row.move(main, force);
    force = false;
    if (main.comment) { row.add(commentHtml(main, cur)); force = true; }
    if (alts.length) { row.add(`<span class="paren">(${seqHtml(alts[0], cur).trimEnd()})</span>`, true); force = true; }
    n = main;
  }
  return row.end();
}
// a board's own tree in «Разбор» / «Репертуар»: its current move gets the ⋯ of its menu
function boardTreeHtml(root, key, tags = null) {
  menuAt = study.node;
  repTags = tags;
  try { return treeHtml(root, study.node, key); } finally { menuAt = null; repTags = null; }
}
function treeHtml(root, cur, key = root.fen || root.id) {
  if (!root.children.length) return "";
  fold = { key, set: foldSet(key), moved: foldShown.get(key) !== cur, dirty: false };
  treeLine = lineIds(root, cur);
  let h = `<div class="tview" data-tree="${esc(key)}">`;
  let node = root;
  let needIdx = true;
  while (node.children.length) {
    const main = node.children[0];
    const alts = node.children.slice(1);
    const white = main.num.endsWith(".");
    if (white) h += idxCell(main.num) + treeMove(main, cur);
    else { if (needIdx) h += `${idxCell(main.num)}<span class="tm empty">…</span>`; h += treeMove(main, cur); }
    needIdx = false;
    const tags = tagsHtml(main);
    if (main.comment || alts.length || main.id === askAt || tags) {
      if (white) h += '<span class="tm empty"></span>';
      h += `<div class="inter">${tags ? `<div class="tags">${tags}</div>` : ""}${askHtml(main)}${commentHtml(main, cur)}${alts.length ? linesHtml(alts, cur) : ""}</div>`;
      needIdx = true;
    }
    node = main;
  }
  foldShown.set(key, cur);
  if (fold.dirty) saveFold(key, fold.set);
  fold = null;
  treeLine = null;
  return `${h}</div>`;
}

// ---- engine (Lichess "ceval") ----
const ceval = { fen: null, res: null, deep: false, timer: null, seq: 0 };

function engineArrow(fen) {
  if (!study.engine || mode !== "study" || rep.drill || rep.game || ceval.fen !== fen || !ceval.res?.lines?.[0]?.uci?.length) return [];
  const u = ceval.res.lines[0].uci[0];
  return [{ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: "paleBlue" }];
}

function requestEval() {
  clearTimeout(ceval.timer);
  if (!study.engine || mode !== "study" || isLive() || rep.drill || rep.game) return; // the drill or a game: no engine hints
  const fen = shownFen;
  if (ceval.fen === fen && ceval.deep) return;
  if (ceval.fen !== fen) { ceval.fen = fen; ceval.res = null; ceval.deep = false; }
  const my = ++ceval.seq;
  ceval.timer = setTimeout(async () => {
    for (const seconds of ceval.res ? [2.5] : [0.35, 2.5]) {
      try {
        const res = await post("/api/analyse", { position: fen, lines: 3, seconds });
        if (my !== ceval.seq || ceval.fen !== fen) return;
        ceval.res = res;
        ceval.deep = seconds > 1;
        renderCeval();
        renderEvalBar();
        if (mode === "study" && shownFen === fen) {
          const node = preview ? null : curNode(); // a line from text has no tree node: only the engine's arrow
          setAutoShapes([...(node?.shapes || []), ...glyphShape(node), ...engineArrow(fen)]);
        }
      } catch { return; }
    }
  }, 150);
}

function evalText(l) {
  if (!l) return "…";
  if (l.mate_white != null) return `#${l.mate_white}`;
  return (l.cp_white >= 0 ? "+" : "") + (l.cp_white / 100).toFixed(2);
}

// The engine block, with its on/off switch in the head (as on Lichess): off, only the switch and the name stay.
const engineSwitch = () => `<button type="button" class="sw" role="switch" id="engine-sw" aria-checked="${study.engine}" aria-label="Stockfish" title="Stockfish (L)"></button>`;
function cevalHtml() {
  if (!study.engine) return `<div class="ceval off" id="ceval"><div class="ceval-head">${engineSwitch()}<span>Stockfish</span></div></div>`;
  const r = ceval.fen === shownFen ? ceval.res : null;
  const head = `<div class="ceval-head">${engineSwitch()}<b>${r?.lines?.length ? evalText(r.lines[0]) : r?.game_over || "…"}</b><span>Stockfish · ${ceval.deep ? "глубже" : "быстро"}</span></div>`;
  const lines = (r?.lines || []).map((l, li) => {
    const nums = numLabels(r.fen, l.san.length);
    const moves = l.san.slice(0, 12).map((s, i) => `${nums[i].endsWith(".") || i === 0 ? `<span class="num">${nums[i]}</span>` : ""}<span class="pvm" data-pv="${li}" data-i="${i}">${esc(s)}</span>`).join(" ");
    return `<div class="pv"><strong>${evalText(l)}</strong><span>${moves}</span></div>`;
  }).join("");
  return `<div class="ceval" id="ceval">${head}${lines}</div>`;
}

function renderCeval() {
  const el = $("#ceval");
  if (el) el.outerHTML = cevalHtml();
}

function renderEvalBar() {
  const bar = $("#evalbar");
  const on = study.engine && mode === "study" && !isLive() && !rep.drill && !rep.game;
  if (bar.hidden === on) { bar.hidden = !on; layout(); }
  if (!on) return;
  const l = ceval.fen === shownFen ? ceval.res?.lines?.[0] : null;
  const w = l ? l.win_white : 50;
  $("#evalfill").style.height = `${w}%`;
  bar.classList.toggle("flipped", cg.state.orientation === "black");
  bar.classList.toggle("black-ahead", w < 50);
  $("#evaltext").textContent = l ? evalText(l).replace("+", "") : "";
}

// ---- study panel ----
function studyPanelHtml() {
  if (rep.on) return repPanelHtml();
  const sc = scene();
  if (!sc) { // a chat without a board, or no boards yet: the tabs row above the board keeps every board reachable
    return `<div class="p-head"><div class="p-title"><h1 class="title">Анализ</h1></div></div>
      <p class="hint">Двигай фигуры на доске или задай позицию:</p>
      <form class="newpos" id="newpos-form"><input id="newpos-input" placeholder="FEN или ходы: 1.e4 e5 2.Nf3" autocomplete="off"><button class="btn primary" type="submit">Создать</button></form>
      ${cevalHtml()}`;
  }
  askAt = curNode()?.by === "user" && !(study.autoAsk && discussed(sc)) && !isLive() ? study.node : null;
  menuAt = study.node;
  const tree = treeHtml(sc.root, study.node, sc.id);
  askAt = menuAt = null;
  return `<div class="p-head"><div class="p-title"><h1 class="title">${esc(sc.title)} ${helpBtn("study")}</h1>${playersHtml(sc)}</div>
      ${dotsBtn("board-menu", "FEN, партия на Lichess, удалить доску")}</div>
    ${helpText("study", `Нажми на ход, чтобы перейти к нему; <span class="kbd">←</span><span class="kbd">→</span> по ходам, <span class="kbd">⇧↑</span><span class="kbd">⇧↓</span> между вариантами.
      <span class="user">Жёлтые</span> — твои ходы, белые — ходы Claude; текст под ходом — комментарий Claude.
      <span class="g g-good">!</span> хороший ход · <span class="g g-mist">?</span> ошибка · <span class="g g-blun">??</span> грубая ошибка · <span class="g g-int">!?</span> интересно.
      Отступ — побочный вариант: <b>−</b> сворачивает, <b>+</b> разворачивает. Меню хода — правый клик, долгое нажатие или ⋯ на текущем ходе.`)}
    ${reviewHtml(sc)}
    ${cevalHtml()}
    ${sc.root.comment ? `<div class="rich lead">${md(sc.root.comment)}</div>` : ""}
    ${tree || `<p class="hint">Ходов пока нет. Сделай ход на доске — он появится здесь.</p>`}`;
}

// the boards the tabs show: this chat's, or the boards without a chat — never another chat
const scopeBoards = (sc) => (chatOf(sc) ? boardsOf(sc.chat) : study.scenes.filter((s) => !chatOf(s) && !s.rep));

// ---- the tabs above the board: in «Разбор» the open chat's boards (or the boards without a chat), in «Репертуар»
// the tree and the open lesson's boards; ＋ makes a board (start, FEN or moves), the list reaches every board — a
// board of another chat comes with its chat ----
function boardTabsHtml() {
  if (mode !== "study" || isLive() || rep.drill || rep.game) return "";
  const sc = scene();
  const tab = (x) => `<button type="button" class="btab${x === sc ? " on" : ""}" role="tab" aria-selected="${x === sc}" data-board="${esc(x.id)}" title="${esc(x.title)}">${esc(x.title)}</button>`;
  const plus = (title) => `<button type="button" class="ibtn" id="board-add" aria-label="Новая доска" title="${title}">${ICON.plus}</button>`;
  if (rep.on) {
    const s = repSec();
    const inLesson = !!s && lessonSection(ch.cur) === s.id;
    const boards = inLesson ? boardsOf(ch.cur) : [];
    if (!inLesson) return "";
    return `<div class="bt-scroll"><button type="button" class="btab${sc?.rep ? " on" : ""}" data-rep-tree>Дерево репертуара</button>${boards.map(tab).join("")}</div>${plus("Ещё одна доска этого урока")}`;
  }
  const any = study.scenes.some((x) => !x.rep);
  return `<div class="bt-scroll">${sc ? scopeBoards(sc).map(tab).join("") : ""}</div>${plus(chatOf(sc) ? "Ещё одна доска в этом чате" : "Новая доска")}
    ${any ? `<button type="button" class="ibtn" id="all-boards" aria-label="Все доски" title="Все доски всех чатов">${ICON.list}</button>` : ""}`;
}
function renderBoardTabs() {
  const el = $("#btabs");
  const h = boardTabsHtml();
  const was = el.hidden;
  el.innerHTML = h;
  el.hidden = !h;
  if (was !== el.hidden) layout();
  $(".btab.on", el)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// every board, grouped by chat (like «Все чаты»)
function allBoardsMenuHtml() {
  const groups = [...ch.list.map((c) => [chatLabel(c), boardsOf(c.id)]), ["Без чата", study.scenes.filter((s) => !chatOf(s) && !s.rep)]]
    .filter(([, l]) => l.length);
  return groups.map(([t, l]) => `<div class="menu-head">${esc(t)}</div>${l.map((x) => `<button type="button" class="mi${x.id === study.id ? " on" : ""}" data-act="board:${esc(x.id)}">${esc(x.title)}</button>`).join("")}`).join("");
}
const newBoardMenuHtml = () => `<div class="menu-head">Новая доска</div>
  <button type="button" class="mi" data-act="start">Начальная позиция</button>
  <div class="menu-head">Из FEN или ходов</div>
  <form class="menu-form"><input name="pos" placeholder="1.e4 e5 2.Nf3" autocomplete="off" aria-label="FEN или ходы"><button class="btn primary" type="submit">Создать</button></form>`;

async function createBoard(position) {
  try {
    const r = await post("/api/scene", { title: "Новая позиция", position: position || "start", chat: claimChat() });
    await waitScene(r.scene);
    setScene(r.scene);
  } catch (err) { setStatus(String(err.message), true); }
}

$("#btabs").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.board) { if (t.dataset.board !== study.id) setScene(t.dataset.board); }
  else if (t.dataset.repTree !== undefined) repShowTree();
  else if (t.id === "board-add") {
    openMenu(t, newBoardMenuHtml(), async (act, el) => {
      if (act === "start") await createBoard("start");
      else if (act === "submit") await createBoard(new FormData(el).get("pos").trim());
    });
    $("#pmenu input")?.focus();
  } else if (t.id === "all-boards") openMenu(t, allBoardsMenuHtml(), (act) => { if (act.startsWith("board:")) setScene(act.slice(6)); });
});

// ⋯ of a board in «Разбор»: its FEN, its game on Lichess, deleting it (asked again in the menu)
function boardMenu(anchor, sc) {
  const g = sc.game || {};
  const items = () => `<button type="button" class="mi" data-act="fen">Скопировать FEN</button>
    ${g.url ? `<button type="button" class="mi" data-act="lichess">Партия на Lichess ↗</button>` : ""}
    <div class="menu-sep"></div>
    <button type="button" class="mi danger" data-act="del">Удалить доску…</button>`;
  openMenu(anchor, items(), async (act) => {
    if (act === "fen") { navigator.clipboard?.writeText(shownFen); setStatus("FEN скопирован"); setTimeout(() => setStatus(""), 1500); }
    else if (act === "lichess") window.open(g.url, "_blank", "noopener");
    else if (act === "del") { setMenu(confirmHtml(`Удалить доску «${esc(sc.title)}»?`, "Её дерево и комментарии пропадут; чат останется.", "del-yes", "Удалить")); return true; }
    else if (act === "cancel") { setMenu(items()); return true; }
    else if (act === "del-yes") deleteBoard(sc);
  });
}
function deleteBoard(sc) {
  const own = scopeBoards(sc);
  const j = own.indexOf(sc);
  study.scenes.splice(study.scenes.indexOf(sc), 1);
  post("/api/scene/delete", { id: sc.id });
  if (own.length > 1) setScene((own[j + 1] || own[j - 1]).id); // another board of this chat (or without a chat)
  else { study.id = null; study.node = "root"; renderStudy(); } // the chat stays, with no board now
}

// a game review: who had White and who had Black, the user's side marked
function playersHtml(sc) {
  const g = sc.game;
  if (!g?.color) return "";
  const side = (c) => {
    const p = g.players?.[c];
    const who = p ? `${esc(p.name)}${p.rating ? ` (${p.rating})` : ""}` : c === g.color ? "ты" : "соперник";
    return `<span><i class="pc ${c}"></i>${c === "white" ? "Белые" : "Чёрные"}: <b>${who}</b>${p && c === g.color ? " — ты" : ""}</span>`;
  };
  return `<div class="players">${side("white")}${side("black")}</div>`;
}

// a game review (coach/review.py): Stockfish's progress, then «ask Claude» and the link to the game
function reviewHtml(sc) {
  const rv = sc.review, g = sc.game || {};
  if (!rv) return "";
  const link = g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">Партия на Lichess ↗</a>` : "";
  if (rv.state === "running" || rv.state === "queued") {
    const p = rv.total ? Math.round((100 * rv.done) / rv.total) : 0;
    return `<div class="review"><div class="review-head"><span class="spin"></span>
      <b>${rv.state === "queued" ? "Разбор ждёт очереди…" : `Stockfish разбирает партию: ${rv.done} из ${rv.total} позиций`}</b></div>
      <div class="bar"><i class="good" style="width:${Math.max(2, p)}%"></i></div></div>`;
  }
  if (rv.state !== "done") {
    return `<div class="review"><p>${rv.state === "failed" ? `Разбор не удался${rv.error ? `: ${esc(rv.error)}` : ""}.` : "Разбор остановлен."}</p>
      <div class="actions"><button type="button" class="btn small primary" data-review="${esc(g.lichess || "")}">Продолжить разбор</button>${link}</div></div>`;
  }
  return `<div class="review-actions"><button type="button" class="btn" id="review-ask">${ICON.spark}Разобрать с Claude</button></div>`;
}

function renderStudyPanel() {
  if (mode !== "study") return;
  const panel = $("#panel");
  panel.innerHTML = studyPanelHtml();
  scrollNearest($(".tview .active", panel), panel);
}

function renderStudy() {
  if (mode !== "study") return;
  const cur = scene();
  if (chatOf(cur)) study.chatBoard[cur.chat] = cur.id; // the server keeps it too (the view report)
  if (!preview) studyBoard();
  renderStudyPanel();
  renderBoardTabs();
  $("#meta").innerHTML = "";
  const sc = scene();
  const e = sc ? tindex(sc).get(study.node) : null;
  $("[data-nav=first]").disabled = $("[data-nav=prev]").disabled = !e?.p;
  $("[data-nav=last]").disabled = $("[data-nav=next]").disabled = !e?.n.children.length;
  updateCounts();
  requestEval();
  renderEvalBar();
  reportView();
}

$("#panel").addEventListener("click", async (e) => {
  if (mode !== "study") return;
  const t = e.target.closest(".tm[data-id], .vm[data-id], button, .pvm");
  if (!t) return;
  if (t.dataset.id) {
    closePreviewSilently();
    study.node = t.dataset.id;
    renderStudy();
  } else if (t.classList.contains("pvm")) {
    const l = ceval.res?.lines?.[Number(t.dataset.pv)];
    if (l) openPreview(playLine(ceval.res.fen, l.uci), Number(t.dataset.i), "Линия Stockfish");
  } else if (t.id === "engine-sw") {
    setEngine(!study.engine);
  } else if (t.dataset.menu) {
    const r = t.getBoundingClientRect();
    openMoveMenu(t.dataset.menu, r.left, r.bottom + 4);
  } else if (t.dataset.board) {
    if (t.dataset.board !== study.id) setScene(t.dataset.board);
  } else if (t.id === "ask-line") {
    askAboutUserLine();
  } else if (t.dataset.review !== undefined) {
    if (t.dataset.review) openReview(t.dataset.review);
  } else if (t.id === "review-ask") {
    const sc = scene();
    if (sc) sendToChat(claudeReviewText(sc), sc);
  } else if (t.id === "board-menu") {
    const sc = scene();
    if (sc) boardMenu(t, sc);
  }
});
$("#panel").addEventListener("change", (e) => {
  if (e.target.id === "lp-angle" || e.target.id === "lp-diff") {
    if (e.target.id === "lp-angle") lp.angle = e.target.value; else lp.difficulty = e.target.value;
    lpSave();
    if (!lp.st || lp.st.done || lp.st.error || (!lp.st.step && !lp.st.wrong)) lpNext();
  }
});
$("#panel").addEventListener("submit", async (e) => {
  if (e.target.id !== "newpos-form") return;
  e.preventDefault();
  await createBoard($("#newpos-input").value.trim());
});

// A tree move's menu: right click, a long press (touch screens have no right click) or the ⋯ on the current move.
function openMoveMenu(id, x, y) {
  if (mode !== "study") return;
  const sc = scene();
  const n = sc && tindex(sc).get(id)?.n;
  if (!n) return;
  const ctx = $("#ctx");
  ctx.innerHTML = `<div class="menu-head">Ход <b>${esc(n.num)}${esc(n.san)}</b></div>
    <button type="button" class="mi" data-act="promote">Сделать главной линией</button>
    ${sc.rep ? `<button type="button" class="mi" data-act="section">Сделать разделом</button>` : ""}
    <button type="button" class="mi" data-act="ask"><span class="spark">✦</span>Спросить Claude про эту позицию</button>
    <button type="button" class="mi" data-act="fen">Скопировать FEN</button>
    ${$(".tview .line[data-fold]", $("#panel")) ? `<button type="button" class="mi" data-act="fold">Свернуть все варианты</button>
    <button type="button" class="mi" data-act="unfold">Развернуть все варианты</button>` : ""}
    <div class="menu-sep"></div>
    <button type="button" class="mi danger" data-act="delete">Удалить с этого хода</button>`;
  ctx.dataset.id = id;
  ctx.hidden = false;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  ctx.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
}
$("#panel").addEventListener("contextmenu", (e) => {
  const t = e.target.closest(".tm[data-id], .vm[data-id]");
  if (!t || mode !== "study") return;
  e.preventDefault();
  openMoveMenu(t.dataset.id, e.clientX, e.clientY);
});
// long press on a move: the same menu; the click that follows the press must not go to the move or close the menu
const press = { timer: 0, x: 0, y: 0, fired: false, at: 0 };
$("#panel").addEventListener("touchstart", (e) => {
  const t = e.target.closest(".tm[data-id], .vm[data-id]");
  clearTimeout(press.timer);
  press.fired = false;
  if (!t || e.touches.length !== 1 || mode !== "study") return;
  const p = e.touches[0];
  Object.assign(press, { x: p.clientX, y: p.clientY });
  press.timer = setTimeout(() => {
    press.fired = true;
    press.at = Date.now();
    navigator.vibrate?.(10);
    openMoveMenu(t.dataset.id, press.x, press.y + 12);
  }, 500);
}, { passive: true });
$("#panel").addEventListener("touchmove", (e) => {
  const p = e.touches[0];
  if (p && Math.hypot(p.clientX - press.x, p.clientY - press.y) > 10) clearTimeout(press.timer);
}, { passive: true });
$("#panel").addEventListener("touchend", (e) => {
  clearTimeout(press.timer);
  if (press.fired) e.preventDefault(); // no click after a long press
  press.fired = false;
}, { passive: false });
$("#panel").addEventListener("touchcancel", () => clearTimeout(press.timer), { passive: true });
// in case a browser still sends the click of the long press: swallow it, it would go to the move and close the menu
document.addEventListener("click", (e) => {
  if (Date.now() - press.at > 600 || e.target.closest("#ctx")) return;
  press.at = 0;
  e.stopPropagation();
  e.preventDefault();
}, { capture: true });
$("#ctx").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const ctx = $("#ctx");
  const id = ctx.dataset.id;
  ctx.hidden = true;
  if (b.dataset.act === "fold" || b.dataset.act === "unfold") { foldAll($("#panel .tview"), b.dataset.act === "fold"); return; }
  const sc = scene();
  const entry = sc && tindex(sc).get(id);
  if (!entry) return;
  if (b.dataset.act === "section") repNewSection(sc.rep, id);
  else if (b.dataset.act === "fen") { navigator.clipboard?.writeText(entry.n.fen); setStatus("FEN скопирован"); setTimeout(() => setStatus(""), 1500); }
  else if (b.dataset.act === "ask") {
    study.node = id;
    renderStudy();
    const path = pathTo(sc, id);
    askClaude(`Поясни позицию после ${path.map((n, i) => (n.num.endsWith(".") || i === 0 ? n.num : "") + n.san).join(" ")}`);
  } else {
    try {
      if (b.dataset.act === "delete") study.node = entry.p?.id || "root";
      await post("/api/scene/edit", { scene: sc.id, at: id, action: b.dataset.act });
    } catch (err) { setStatus(String(err.message), true); }
  }
});
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx, .mv-menu")) $("#ctx").hidden = true; });

// =====================================================================
// PUZZLES — positions from the user's games
// =====================================================================
const PASS = 8;
const MIN = 60e3, DAY = 864e5;
const INTERVALS = [10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY];
const RECENT = 20; // puzzles shown lately are not picked again, whatever their due time

// ids of the puzzles shown lately, newest last (kept across reloads)
let recent = [];
try { recent = JSON.parse(localStorage.getItem("puzzle.recent") || "[]"); } catch {}
function remember(id) {
  recent = [...recent.filter((x) => x !== id), id].slice(-60);
  try { localStorage.setItem("puzzle.recent", JSON.stringify(recent)); } catch {}
  http.send("PUT", "/api/settings", { recent }).catch(() => {});
}
const KIND = { blunder: "Не зевни", missed: "Накажи" };
const PHASE = { opening: "Дебют", middlegame: "Миттельшпиль", endgame: "Эндшпиль" };
const SIDE = { white: "белых", black: "чёрных" };

const pz = { list: [], byId: {}, prog: {}, cur: null, st: null, session: { done: 0, ok: 0 }, filt: { kind: "all", phase: "all", color: "all" }, flipped: false };

// ---------------- LPUZZLE: rated Lichess puzzles, picked by the user's weaknesses ----------------
// login is shared with live games (coach/lichess.py); results go to the user's puzzle rating on Lichess
const lp = { on: false, ready: false, loading: false, req: 0, status: null, ru: {}, cur: null, meta: null, st: null, difficulty: "normal", angle: "weak", weak: null, showWeak: false };
const DIFF_RU = { easiest: "Самые лёгкие", easier: "Легче", normal: "Мой уровень", harder: "Сложнее", hardest: "Самые сложные" };
const themeRu = (t) => lp.ru[t] || t;
const lpSave = () => http.send("PUT", "/api/settings", { lpuzzle: { on: lp.on, difficulty: lp.difficulty, angle: lp.angle, custom: lp.custom || null } }).catch(() => {});
// an opening of the repertoire as the Lichess theme (lp.custom = {angle, name, section}: «Задачи Lichess» of a section)
const lpOpening = () => (lp.custom && lp.custom.angle === lp.angle ? lp.custom : null);

async function lpEnsure() {
  if (lp.ready) return;
  lp.ready = true;
  try {
    const s = await http.get("/api/state");
    Object.assign(lp, s.settings?.lpuzzle || {});
  } catch {}
  await lpRefresh();
}

async function lpRefresh() {
  try {
    const st = await http.get("/api/lpuzzle/status");
    lp.status = st;
    lp.ru = st.themes || lp.ru;
  } catch (err) { lp.status = { error: String(err.message || err) }; }
}

function lpView() {
  const p = lp.cur, st = lp.st;
  if (!p) return null;
  return { source: "lichess", id: p.id, rating: p.rating, themes: p.themes, fen: p.fen, side_to_move: p.color,
    opponent_last_move: p.lastSan, solution: p.solutionSan.join(" "), solved_steps: st.step, failed: st.failed,
    wrong_move: st.wrong?.san || null, finished: st.done, url: `https://lichess.org/training/${p.id}` };
}

async function lpNext() {
  const my = ++lp.req; // only the latest request fills the board (the theme may change while one is on the way)
  lp.loading = true;
  lp.cur = null;
  lp.st = null;
  pz.flipped = false; // each puzzle starts from the solver's side, as with the user's own puzzles
  closePreviewSilently();
  renderPuzzlePanel();
  try {
    const r = await post("/api/lpuzzle/next", { difficulty: lp.difficulty, angle: lp.angle });
    if (my !== lp.req) return;
    lp.cur = r.puzzle;
    lp.meta = { angle: r.angle, angleName: lp.custom?.angle === r.angle ? `Дебют: ${lp.custom.name}` : r.angleName, weak: r.weak, why: r.why, rated: r.rated };
    lp.st = { step: 0, fen: r.puzzle.fen, last: r.puzzle.last, failed: false, done: false, submitted: false, why: null, wrong: null, result: null, shapes: [] };
    if (r.glicko && lp.status) lp.status.glicko = r.glicko;
  } catch (err) {
    if (my !== lp.req) return;
    lp.st = { error: String(err.message || err) };
  }
  lp.loading = false;
  if (mode === "puzzle") { lpBoard(); renderPuzzlePanel(); renderMeta(); reportView(); }
}

function lpBoard() {
  const p = lp.cur, st = lp.st;
  if (!p || !st || st.error) return;
  const movable = !st.done && !st.wrong;
  setBoard({
    fen: st.fen, orientation: boardOrientation(), lastMove: st.last ? sq(st.last) : undefined, shapes: st.shapes || [],
    movable: movable ? { color: p.color, dests: legalDests(st.fen), after: lpMove } : null,
  });
}

async function lpMove(orig, dest) {
  const p = lp.cur, st = lp.st;
  const want = p.solution[st.step];
  let uci = orig + dest;
  if (isPromotion(st.fen, orig, dest)) { // the user picks the piece (taking it from the solution would give it away)
    const piece = await choosePromotion(dest, p.color);
    if (!piece || lp.st !== st) { lpBoard(); return; }
    uci += piece;
  }
  const c = new Chess(st.fen);
  let m;
  try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); } catch { lpBoard(); return; }
  uci = m.from + m.to + (m.promotion || "");
  if (uci === want || c.isCheckmate()) { // Lichess also accepts any mate
    st.fen = c.fen();
    st.last = uci;
    st.step++;
    st.shapes = [];
    if (st.step >= p.solution.length || c.isCheckmate()) { lpFinish(true); return; }
    lpBoard();
    setTimeout(() => { // the opponent's reply from the solution
      if (lp.st !== st) return;
      const reply = p.solution[st.step];
      const c2 = new Chess(st.fen);
      c2.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
      st.fen = c2.fen();
      st.last = reply;
      st.step++;
      if (st.step >= p.solution.length) lpFinish(true); else { lpBoard(); renderPuzzlePanel(); }
      reportView();
    }, 450);
    renderPuzzlePanel();
    reportView();
    return;
  }
  // a wrong move: the puzzle counts as failed; explain with the engine
  const before = st.fen;
  st.wrong = { uci, san: m.san, before };
  st.failed = true;
  st.fen = c.fen();
  st.last = uci;
  st.why = { loading: true };
  lpBoard();
  lpSubmit(false);
  post("/api/lpuzzle/explain", { fen: before, uci, best: want }).then((res) => {
    if (lp.st !== st) return;
    st.why = res;
    if (res.ok) st.why = { ...res, text: `Движок считает ${m.san} почти таким же сильным, но в задаче Lichess нужен один конкретный ход. ${res.text}` };
    st.shapes = res.shapes || [];
    if (!preview) lpBoard();
    renderPuzzlePanel();
  }).catch(() => { st.why = { text: "Не удалось получить разбор от движка." }; renderPuzzlePanel(); });
  renderPuzzlePanel();
  reportView();
}

function lpFinish(win) {
  const st = lp.st;
  st.done = true;
  lpBoard();
  if (!st.failed) lpSubmit(win);
  renderPuzzlePanel();
  reportView();
}

function lpSubmit(win) {
  const st = lp.st, p = lp.cur;
  if (st.submitted) return;
  st.submitted = true;
  post("/api/lpuzzle/solve", { id: p.id, win, angle: lp.meta?.angle || "mix" }).then((res) => {
    st.result = { win, ...res };
    if (res.glicko && lp.status) lp.status.glicko = res.glicko;
    renderPuzzlePanel();
  }).catch((err) => { st.result = { win, error: String(err.message || err) }; renderPuzzlePanel(); });
}

// the solution is played on the board move by move from the puzzle position, as on Lichess
function lpPlaySolution() {
  const p = lp.cur;
  openPreview(playLine(p.fen, p.solution), -1, "Решение");
  const mine = preview;
  const timer = setInterval(() => {
    if (preview !== mine || preview.idx >= preview.plies.length - 1) { clearInterval(timer); return; }
    previewStep("next");
  }, 900);
  // the user takes over (arrows, clicks on moves, «Вернуться»): stop playing
  const stop = () => { clearInterval(timer); document.removeEventListener("keydown", stop, true); $("#preview").removeEventListener("click", stop, true); };
  document.addEventListener("keydown", stop, true);
  $("#preview").addEventListener("click", stop, true);
}

function lpRetry() { // back to the position before the wrong move; no longer rated
  const st = lp.st;
  if (!st?.wrong) return;
  st.fen = st.wrong.before;
  st.last = null;
  st.wrong = null;
  st.why = null;
  st.shapes = [];
  closePreviewSilently();
  lpBoard();
  renderPuzzlePanel();
}

function lpPanelHtml() {
  const acc = lp.status?.account;
  const g = lp.status?.glicko;
  let h = "";
  if (!lp.status) h += `<p class="hint">Связываюсь с Lichess…</p>`;
  else if (lp.status.error) h += `<p class="msg-error">${esc(lp.status.error)}</p>`;
  else if (!acc?.connected) {
    h += `<div class="result info"><h3>Подключи Lichess</h3>
      <p>Задачи пойдут в твой настоящий рейтинг задач на Lichess. Откроется lichess.org в браузере: войди там и разреши доступ. Ключ хранится только на этом Mac.</p>
      <div class="actions"><a class="btn primary" href="/api/lichess/login" target="_blank" rel="noopener">Подключить Lichess</a>
      <button type="button" class="btn quiet" id="lp-recheck">Я подключил</button></div>
      <p class="hint">Без входа задачи тоже есть (около 1500), но не в рейтинг.</p></div>`;
  } else {
    h += `<div class="ladder"><div class="lr"><b>${g?.rating ? Math.round(g.rating) : "…"}</b><span>рейтинг задач на Lichess · ${esc(acc.user || "")}</span></div>
      ${lp.status.rated ? "" : `<div class="lr-meta">у входа нет права записи задач — подключи Lichess заново</div>`}</div>`;
  }
  const angles = [["weak", "Под мои слабости"], ["mix", "Смесь"], ...(lp.custom ? [[lp.custom.angle, `Дебют: ${lp.custom.name}`]] : []), ...(lp.weak || []).map((w) => [w.theme, w.name])];
  h += `<div class="lp-opts">
    <select id="lp-angle" title="Тема задач">${angles.filter((a, i, arr) => arr.findIndex((x) => x[0] === a[0]) === i).map(([v, t]) => `<option value="${v}"${v === lp.angle ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>
    <select id="lp-diff" title="Сложность относительно твоего рейтинга">${["easier", "normal", "harder"].map((v) => `<option value="${v}"${v === lp.difficulty ? " selected" : ""}>${DIFF_RU[v]}</option>`).join("")}</select>
    <button type="button" class="link-btn" id="lp-weak-toggle">${lp.showWeak ? "скрыть слабости" : "мои слабости"}</button></div>`;
  if (lp.showWeak) {
    h += lp.weak ? `<div class="lp-weak">${lp.weak.map((w) => `<div><b>${esc(w.name)}</b> — <span class="hint">${esc(w.why)}</span>
        ${w.examples?.length ? `<div class="lp-ex">примеры из твоих партий: ${w.examples.map((id, i) => `<button type="button" class="link-btn" data-own="${id}">${i + 1}</button>`).join(" ")}</div>` : ""}</div>`).join("")}</div>`
      : `<p class="hint">Считаю слабости…</p>`;
  }
  h += `<hr class="sep">`;
  const p = lp.cur, st = lp.st;
  if (st?.error) return h + `<p class="msg-error">${esc(st.error)}</p><div class="actions"><button type="button" class="btn primary" id="lp-next">Ещё раз</button></div>`;
  if (!p) return h + `<p class="hint">Загружаю задачу с Lichess…</p>`;
  const side = p.color === "white" ? "белых" : "чёрных";
  h += `<div class="task"><div class="eyebrow"><span class="tag missed">Lichess</span><span class="ph">${esc(lp.meta?.angleName || "")}${lp.meta?.weak ? " · твоя слабость" : ""}</span></div>
    <h2>Ход ${side}</h2><p>Соперник сыграл <span class="san hov" data-arrow="${p.last || ""}" data-brush="orange">${esc(p.lastSan || "")}</span>. Найди лучшее продолжение${p.solution.length > 1 ? " — до конца варианта" : ""}.</p>
    ${lp.meta?.weak && lp.meta.why ? `<p class="hint">Почему эта тема: ${esc(lp.meta.why)}</p>` : ""}</div>`;
  if (st.wrong) {
    h += `<div class="result fail"><h3>Не то: <span class="san">${esc(st.wrong.san)}</span></h3>${whyHtml(st.why)}</div>`;
  } else if (st.done) {
    h += `<div class="result ${st.failed ? "info" : "ok"}"><h3>${st.gaveUp ? "Решение показано" : st.failed ? "Решено со второй попытки" : "Решено!"}</h3>
      ${st.gaveUp ? `<p>Решение: ${inline(p.solutionSan.map((x, i) => (i === 0 || p.color === "white" ? "" : "") + x).join(" "))}</p>` : ""}</div>`;
  } else if (st.step > 0) {
    h += `<p class="hint">Верно, продолжай.</p>`;
  }
  const r = st.result;
  if (r) {
    if (r.error) h += `<p class="msg-error">Результат не ушёл на Lichess: ${esc(r.error)}</p>`;
    else if (r.rated && r.ratingDiff != null) h += `<p class="rdelta">Рейтинг на Lichess: <b>${Math.round(r.glicko?.rating ?? 0)}</b> <span class="${r.ratingDiff >= 0 ? "up" : "down"}">(${r.ratingDiff >= 0 ? "+" : ""}${r.ratingDiff})</span></p>`;
    else if (!r.rated) h += `<p class="hint">Без входа в Lichess результат не идёт в рейтинг.</p>`;
  }
  if (st.done || st.wrong) {
    h += `<p class="hint">Задача ${p.rating} · ${p.themes.map(themeRu).map(esc).join(", ")} · <a href="https://lichess.org/training/${esc(p.id)}" target="_blank" rel="noopener">на Lichess ↗</a></p>`;
  }
  h += `<div class="actions">`;
  if (st.wrong) h += `<button type="button" class="btn primary" id="lp-retry">Ещё раз</button><button type="button" class="btn" id="lp-solution">Показать решение</button><button type="button" class="btn quiet" id="lp-next">Дальше</button>`;
  else if (st.done) h += `<button type="button" class="btn primary" id="lp-next">Дальше</button><button type="button" class="btn" id="lp-solution">Решение</button><button type="button" class="btn" id="lp-study">Открыть в анализе</button>`;
  else h += `<button type="button" class="btn" id="lp-solution">Сдаться и показать решение</button>`;
  h += `<button type="button" class="btn" id="lp-ask">Спросить Claude</button></div>`;
  return h;
}

async function lpClick(t) {
  const p = lp.cur, st = lp.st;
  if (t.dataset.own) { // an example from the user's own games
    lp.on = false;
    lpSave();
    loadPuzzle(pz.byId[t.dataset.own]);
    renderPuzzlePanel();
    return;
  }
  switch (t.id) {
    case "lp-next": lpNext(); break;
    case "lp-retry": lpRetry(); break;
    case "lp-recheck": await lpRefresh(); renderPuzzlePanel(); break;
    case "lp-weak-toggle":
      lp.showWeak = !lp.showWeak;
      renderPuzzlePanel();
      if (lp.showWeak && !lp.weak) { try { lp.weak = (await http.get("/api/lpuzzle/weak")).themes; } catch { lp.weak = []; } renderPuzzlePanel(); }
      break;
    case "lp-solution":
      if (!st.done) { // giving up ends the puzzle: rated as a loss, then «Дальше» is offered
        if (!st.failed) { st.failed = true; lpSubmit(false); }
        st.done = true;
        st.gaveUp = true;
      }
      lpPlaySolution();
      renderPuzzlePanel();
      reportView();
      break;
    case "lp-study":
      post("/api/scene", { title: `Lichess ${p.id}: ${p.themes.map(themeRu).slice(0, 3).join(", ")}`, position: p.fen, orientation: p.color,
        lines: [{ title: "решение", moves: p.solution }] }).catch((err) => setStatus(String(err.message), true));
      break;
    case "lp-ask":
      askClaude(st.wrong ? `Почему мой ход ${st.wrong.san} в этой задаче с Lichess плохой? Покажи на доске.` : `Поясни эту задачу с Lichess: почему решение ${p.solutionSan.join(" ")}? Покажи на доске.`);
      break;
  }
}

window.__lp = { move: (o, d) => lpMove(o, d), view: () => lpView(), st: () => lp.st }; // test handle (dev harness)

window.addEventListener("focus", async () => { // back from the browser after connecting Lichess
  if (lp.on && mode === "puzzle" && !lp.status?.account?.connected) { await lpRefresh(); renderPuzzlePanel(); }
});

// ---------------- rating ladder ----------------
// user rating, games, best, history [[time, id, ok, delta, rating]], per-puzzle rating corrections
const ladder = { on: false, rating: 1500, games: 0, best: 1500, hist: [], pr: {} };
const saveLadder = () => http.send("PUT", "/api/settings", { ladder }).catch(() => {});

function probit(q) { // inverse normal CDF (Acklam)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (t) => (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
  if (q < 0.02425) return tail(Math.sqrt(-2 * Math.log(q)));
  if (q > 0.97575) return -tail(Math.sqrt(-2 * Math.log(1 - q)));
  const t = q - 0.5, r = t * t;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * t) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// how hard a puzzle is, from its engine data: few moves that hold, a quiet best move, a deep point
function difficultyScore(p) {
  const ws = Object.values(p.moves).map((m) => m[0]).sort((x, y) => y - x);
  const best = ws[0], second = ws[1] ?? 0, total = ws.length;
  const good = ws.filter((w) => best - w <= PASS).length;
  let score = 2 * (1 - good / total);
  score += good === 1 ? 0.9 : good === 2 ? 0.45 : good <= 4 ? 0.15 : -0.3;
  if (best - second > 25) score += 0.3;
  const c = new Chess(p.fen);
  const me = p.fen.split(" ")[1];
  let depth = 0, bal = 0;
  for (const [i, u] of [p.best, ...(p.moves[p.best][1] || [])].entries()) {
    let m;
    try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    if (i === 0) score += m.san.includes("+") ? -0.5 : m.captured ? -0.35 : 0.45; // forcing moves are easier to find
    if (m.captured) bal += (m.color === me ? 1 : -1) * ({ p: 1, n: 3, b: 3, r: 5, q: 9 }[m.captured] || 0);
    if (bal >= 2 && !depth) depth = i + 1;
  }
  if (p.kind === "missed") score += 0.35 + Math.min(depth || 6, 8) * 0.12;
  return score;
}

// spread the puzzles over a rating scale (mean 1500, sd 330) by their difficulty rank
function assignRatings(list) {
  const scored = list.map((p) => [difficultyScore(p), p]).sort((x, y) => x[0] - y[0]);
  scored.forEach(([, p], i) => { p._r0 = Math.max(800, Math.min(2300, Math.round(1500 + 330 * probit((i + 0.5) / scored.length)))); });
}
const puzzleRating = (p) => Math.round((p._r0 ?? 1500) + (ladder.pr[p.id] || 0));

function pickLadder() {
  const all = pz.list.filter((p) => match(p) && p !== pz.cur);
  const lately = new Set(recent.slice(-RECENT));
  let pool = all.filter((p) => !lately.has(p.id) && (pz.prog[p.id]?.box || 0) < 3);
  if (!pool.length) pool = all;
  const target = ladder.rating + 30;
  const near = pool.map((p) => [Math.abs(puzzleRating(p) - target) + (pz.prog[p.id] ? 60 : 0), p]).sort((x, y) => x[0] - y[0]).slice(0, 6);
  return near[Math.floor(Math.random() * near.length)]?.[1] || null;
}

function rateAttempt(p, ok) {
  const P = puzzleRating(p), U = ladder.rating;
  const expected = 1 / (1 + 10 ** ((P - U) / 400));
  const K = ladder.games < 10 ? 60 : ladder.games < 30 ? 36 : 22;
  const delta = Math.round(K * ((ok ? 1 : 0) - expected));
  ladder.rating = U + delta;
  ladder.games++;
  ladder.best = Math.max(ladder.best, ladder.rating);
  ladder.pr[p.id] = (ladder.pr[p.id] || 0) - Math.round(12 * ((ok ? 1 : 0) - expected));
  ladder.hist = [...ladder.hist, [Date.now(), p.id, ok ? 1 : 0, delta, ladder.rating]].slice(-500);
  pz.st.rated = { before: U, after: ladder.rating, delta, P };
  saveLadder();
}

function ladderHtml() {
  const last = ladder.hist.slice(-12).map((h) => `<span class="${h[2] ? "ok" : "bad"}">${h[2] ? "✓" : "✗"}</span>`).join("");
  const solved = ladder.hist.filter((h) => h[2]).length;
  return `<div class="ladder"><div class="lr"><b>${ladder.rating}</b><span>твой рейтинг задач</span></div>
    <div class="lr-meta">лучший ${ladder.best} · решено ${solved} из ${ladder.hist.length}${last ? ` · <span class="lr-last">${last}</span>` : ""}</div></div>`;
}

function match(p, f = pz.filt) {
  if (pz.only && !pz.only.ids.has(p.id)) return false; // the puzzles of a repertoire section (REPERTOIRE)
  return (f.kind === "all" || p.kind === f.kind) && (f.phase === "all" || p.phase === f.phase) && (f.color === "all" || p.color === f.color);
}

function pickNext() {
  if (ladder.on) return pickLadder();
  const now = Date.now();
  const all = pz.list.filter((p) => match(p) && p !== pz.cur);
  const lately = new Set(recent.slice(-RECENT));
  const pool = all.filter((p) => !lately.has(p.id)).length ? all.filter((p) => !lately.has(p.id)) : all;
  if (!pool.length) return pz.list.filter((p) => match(p))[0] || null;
  const due = pool.filter((p) => pz.prog[p.id] && pz.prog[p.id].due <= now).sort((a, b) => pz.prog[a.id].due - pz.prog[b.id].due);
  if (due.length) return due[0];
  const fresh = pool.filter((p) => !pz.prog[p.id]).sort((a, b) => hash(a.id) - hash(b.id));
  if (fresh.length) return fresh[0];
  return pool.sort((a, b) => pz.prog[a.id].due - pz.prog[b.id].due)[0];
}

function record(p, ok) {
  if (ladder.on) rateAttempt(p, ok);
  const old = pz.prog[p.id] || {};
  const box = ok ? Math.min((old.box || 0) + 1, INTERVALS.length - 1) : 0;
  const now = Date.now();
  const rec = { box, due: now + INTERVALS[ok ? box : 0], ok: (old.ok || 0) + (ok ? 1 : 0), fail: (old.fail || 0) + (ok ? 0 : 1), last: now, lastOk: ok };
  pz.prog[p.id] = rec;
  http.send("PUT", `/api/progress/${encodeURIComponent(p.id)}`, rec).catch(() => setStatus("прогресс не сохранился", true));
  http.send("PUT", "/api/settings", { puzzle: null }).catch(() => {}); // answered: after a restart show the next one
}

function puzzleBoard() {
  if (lp.on) { lpBoard(); return; }
  const p = pz.cur, st = pz.st;
  if (!p) return;
  if (st.result && !st.solution) {
    const r = st.result;
    const after = playLine(p.fen, [r.uci]).plies[0];
    setBoard({ fen: after.fen, orientation: boardOrientation(), lastMove: sq(r.uci), shapes: r.ok ? [] : st.why?.shapes || st.quickShapes || [] });
    return;
  }
  const movable = !st.result && !st.solution;
  let shapes = [];
  if (st.hinted && movable) shapes = [{ orig: p.best.slice(0, 2), brush: "green" }];
  if (st.solution) shapes = [{ orig: p.best.slice(0, 2), dest: p.best.slice(2, 4), brush: "green" }, { orig: p.played.slice(0, 2), dest: p.played.slice(2, 4), brush: "red" }];
  setBoard({
    fen: p.fen, orientation: boardOrientation(), lastMove: p.last ? sq(p.last) : undefined, shapes,
    movable: movable ? { color: p._turn, dests: p._dests, after: onPuzzleMove } : null,
  });
}

function loadPuzzle(p) {
  closePreviewSilently();
  if (p && p !== pz.cur) {
    remember(p.id);
    http.send("PUT", "/api/settings", { puzzle: p.id }).catch(() => {}); // reopen it after a restart until it is answered
  }
  pz.cur = p;
  pz.flipped = false;
  pz.st = { recorded: false, hinted: false, solution: false, result: null, attempts: [], why: null, best: null, fens: [], tree: null };
  if (p && !p._dests) {
    const dests = new Map();
    for (const u of Object.keys(p.moves)) {
      const [f, t] = sq(u);
      if (!dests.has(f)) dests.set(f, []);
      if (!dests.get(f).includes(t)) dests.get(f).push(t);
    }
    p._dests = dests;
    p._turn = turnOf(p.fen);
    p._best = Math.max(...Object.values(p.moves).map((m) => m[0]));
    p._good = Object.values(p.moves).filter((m) => p._best - m[0] <= PASS).length;
    p._total = Object.keys(p.moves).length;
  }
  if (mode === "puzzle") renderPuzzle();
}
const nextPuzzle = () => loadPuzzle(pickNext());

async function onPuzzleMove(orig, dest) {
  const p = pz.cur, st = pz.st;
  let uci = orig + dest;
  if (!p.moves[uci] && isPromotion(p.fen, orig, dest)) {
    const piece = await choosePromotion(dest, p._turn);
    if (!piece || pz.cur !== p) { puzzleBoard(); return; }
    uci += piece;
  }
  if (!p.moves[uci]) uci = p.moves[uci + "q"] ? uci + "q" : Object.keys(p.moves).find((u) => u.startsWith(uci)) || uci;
  const m = p.moves[uci];
  if (!m) { puzzleBoard(); return; }
  const ok = p._best - m[0] <= PASS;
  st.result = { uci, san: playLine(p.fen, [uci]).plies[0].san, w: m[0], ok };
  st.attempts.push(uci);
  st.why = null;
  st.quickShapes = !ok && m[1][0] ? [{ orig: m[1][0].slice(0, 2), dest: m[1][0].slice(2, 4), brush: "red" }] : [];
  if (!st.recorded) {
    st.recorded = true;
    const clean = ok && !st.hinted;
    record(p, clean);
    pz.session.done++;
    if (clean) pz.session.ok++;
  }
  puzzleBoard();
  if (ok) loadBest();
  else {
    st.why = { loading: true };
    const tries = st.attempts.length;
    post("/api/explain", { id: p.id, uci }).then((res) => {
      if (pz.cur !== p || st.attempts.length !== tries) return;
      st.why = res;
      collectFens(res);
      if (!preview) puzzleBoard();
      renderPuzzlePanel();
    }).catch(() => { st.why = { text: "Не удалось получить разбор от движка." }; renderPuzzlePanel(); });
  }
  renderPuzzlePanel();
  reportView();
}

function collectFens(res) {
  for (const l of [res.line, ...(res.lines || [])]) {
    if (!l?.plies) continue;
    pz.st.fens.push(l.start, ...l.plies.map((x) => x.fen));
  }
}

function loadBest() {
  const p = pz.cur, st = pz.st;
  if (st.best) return;
  st.best = { loading: true };
  post("/api/explain", { id: p.id }).then((res) => {
    if (pz.cur !== p) return;
    st.best = res;
    collectFens(res);
    renderPuzzlePanel();
  }).catch(() => { st.best = { text: "" }; renderPuzzlePanel(); });
}

function meter(label, w, cls) {
  return `<div class="meter-row"><span>${label}</span><div class="bar"><i class="${cls}" style="width:${Math.max(2, Math.min(100, w))}%"></i></div><b>${pct(w)}</b></div>`;
}

function whyHtml(x) {
  if (!x) return "";
  if (x.loading) return `<p class="why loading">Разбираю ход движком…</p>`;
  return x.text ? `<div class="why rich">${md(x.text, x.lines)}</div>` : "";
}

// the solution lines as a small move tree: best line = main line, then the user's tries and the game move
function solutionTree() {
  const p = pz.cur, st = pz.st;
  const root = { id: "p0", fen: p.fen, children: [] };
  let n = 0;
  const add = (line, label) => {
    if (!line?.plies?.length) return;
    let node = root;
    line.plies.forEach((pl, i) => {
      let c = node.children.find((x) => x.uci === pl.uci);
      if (!c) {
        c = { id: `p${++n}`, uci: pl.uci, san: pl.san, num: pl.num, fen: pl.fen, comment: "", glyph: "", label: i === 0 ? label : "", children: [] };
        node.children.push(c);
      }
      node = c;
    });
  };
  const stored = (u) => playLine(p.fen, [u, ...p.moves[u][1]]);
  add(st.best?.line?.plies?.length ? st.best.line : stored(p.best), "лучший");
  for (const u of new Set(st.attempts)) if (u !== p.best) add(u === st.result?.uci && st.why?.line?.plies ? st.why.line : stored(u), "твой ход");
  if (p.played !== p.best) add(stored(p.played), "в партии");
  st.tree = root;
  return root;
}

function renderPuzzlePanel() {
  if (mode !== "puzzle") return;
  const panel = $("#panel");
  const p = pz.cur, st = pz.st;
  let html = `<div class="pmode" role="group" aria-label="Режим задач">
      <button type="button" class="chip" data-pmode="srs" aria-pressed="${!ladder.on && !lp.on}" title="Задачи возвращаются на повтор: ошибки — скоро, решённые — всё реже">Повторение</button>
      <button type="button" class="chip" data-pmode="ladder" aria-pressed="${ladder.on && !lp.on}" title="Задачи под твой рейтинг: решил — рейтинг растёт и задачи сложнее">Рейтинг</button>
      <button type="button" class="chip" data-pmode="lichess" aria-pressed="${lp.on}" title="Задачи с Lichess в твой рейтинг на Lichess, подбор под твои слабости">Lichess</button>
    </div>`;
  const op = lp.on ? lpOpening() : null;
  if (op || (!lp.on && pz.only)) { // puzzles of a repertoire section: say so, with the way back
    const n = op ? "" : `: ${pz.list.filter((x) => match(x, { kind: "all", phase: "all", color: "all" })).length}`;
    html += `<div class="rep-trial"><div>${op ? `Задачи Lichess в дебюте «${esc(op.name)}»` : `Мои задачи из партий раздела «${esc(pz.only.name)}»${n}`}</div>
      <div class="actions">${op ? "" : `<button type="button" class="link-btn" id="puz-all">все мои задачи</button>`}<button type="button" class="link-btn" id="puz-rep">← в репертуар</button></div></div>`;
  }
  if (lp.on) { panel.innerHTML = html + lpPanelHtml(); return; }
  html += `<div class="stats" id="stats"></div><div class="filters" id="filters"></div><hr class="sep">`;
  if (!p) {
    panel.innerHTML = `${html}<p class="empty">Под этот фильтр позиций нет. Сними часть фильтров выше.</p>`;
    renderStats(); renderFilters();
    return;
  }
  const lastSan = p.lastSan ? `<span class="san hov" data-arrow="${p.last || ""}" data-brush="orange">${esc(p.lastSan)}</span>` : "";
  const task = p.kind === "missed"
    ? `Соперник только что ошибся: ${lastSan}. В партии ты этим не воспользовался. Найди ход, который забирает преимущество.`
    : `Соперник сыграл ${lastSan || "ход"}. В партии ты здесь ошибся. Сначала проверь, что он грозит и что останется без защиты после твоего хода, потом ходи.`;
  html += `<div class="task">
    <div class="eyebrow"><span class="tag ${p.kind}">${KIND[p.kind]}</span><span class="ph">${PHASE[p.phase]} · ${p.moveNo}-й ход</span></div>
    <h2>Ход ${SIDE[p._turn]}</h2><p>${task}</p></div>`;
  const r = st.result;
  const finished = (r && r.ok) || st.solution;
  if (r) {
    if (r.ok) {
      const bestSan = playLine(p.fen, [p.best]).plies[0]?.san;
      html += `<div class="result ok"><h3>${st.hinted ? "Верно, с подсказкой" : "Верно"}: <span class="san">${esc(r.san)}</span></h3>
        <p>${r.uci === p.best ? "Это лучший ход по оценке движка." : `Движок чуть больше любит <span class="san hov" data-arrow="${p.best}">${esc(bestSan)}</span>, но твой ход тоже держит позицию.`}</p>
        ${whyHtml(st.best)}</div>`;
    } else {
      html += `<div class="result fail"><h3>Не то: <span class="san">${esc(r.san)}</span></h3>${whyHtml(st.why)}</div>`;
      if (st.solution) html += `<div class="result info"><h3>Решение</h3>${whyHtml(st.best)}</div>`;
    }
    if (st.rated) {
      const d = st.rated.delta;
      html += `<p class="rdelta">Рейтинг ${st.rated.before} → <b>${st.rated.after}</b> <span class="${d >= 0 ? "up" : "down"}">(${d >= 0 ? "+" : ""}${d})</span> · сложность задачи ${st.rated.P}</p>`;
    }
    html += `<div class="meter">${meter("лучший ход", p._best, "good")}${meter("твой ход", r.w, r.ok ? "good" : "bad")}${meter("в партии", p.moves[p.played][0], "bad")}</div>`;
  } else if (st.solution) {
    html += `<div class="result info"><h3>Решение</h3>${whyHtml(st.best)}</div>`;
  }
  if (finished) {
    html += treeHtml(solutionTree(), preview?.nodeId || "");
    html += `<p class="hint">Нажми на ход — позиция появится на доске, дальше <span class="kbd">←</span><span class="kbd">→</span>.</p>`;
  }
  html += `<div class="actions">`;
  if (!r && !st.solution) {
    html += `<button type="button" class="btn" id="hint" ${st.hinted ? "disabled" : ""}>Подсказка</button>
      <button type="button" class="btn" id="solve">Показать решение</button>
      <button type="button" class="btn quiet" id="skip">Пропустить</button>`;
  } else if (finished) {
    html += `<button type="button" class="btn primary" id="next">Дальше</button>
      <button type="button" class="btn" id="to-study">Открыть в анализе</button>`;
  } else {
    html += `<button type="button" class="btn primary" id="retry">Ещё раз</button>
      <button type="button" class="btn" id="solve">Показать решение</button>
      <button type="button" class="btn quiet" id="next">Дальше</button>`;
  }
  html += `<button type="button" class="btn" id="ask-claude">Спросить Claude</button></div>`;
  panel.innerHTML = html;
  renderStats();
  renderFilters();
}

$("#panel").addEventListener("click", async (e) => {
  if (mode !== "puzzle") return;
  const t = e.target.closest("button, .tm[data-id], .vm[data-id]");
  if (!t) return;
  if (lp.on && !t.dataset.pmode && (t.id?.startsWith("lp-") || t.dataset.own)) { lpClick(t); return; }
  const p = pz.cur, st = pz.st;
  if (t.dataset.id) {
    const trail = [];
    const walk = (n, acc) => (n.id === t.dataset.id ? (trail.push(...acc), true) : n.children.some((c) => walk(c, [...acc, c])));
    if (st.tree && walk(st.tree, []) && trail.length) {
      openPreview({ start: p.fen, plies: trail }, trail.length - 1, "Решение");
      preview.nodeId = t.dataset.id;
      renderPuzzlePanel();
    }
    return;
  }
  if (t.dataset.pmode) {
    const wasLp = lp.on;
    lp.on = t.dataset.pmode === "lichess";
    lpSave();
    if (lp.on) {
      await lpEnsure();
      lp.on = true;
      renderMeta();
      if (!lp.cur) lpNext(); else { lpBoard(); renderPuzzlePanel(); }
      return;
    }
    if (wasLp) { closePreviewSilently(); puzzleBoard(); renderMeta(); }
    ladder.on = t.dataset.pmode === "ladder";
    saveLadder();
    if (!st?.result && !st?.solution) nextPuzzle(); else renderPuzzlePanel();
    return;
  }
  if (t.classList.contains("chip")) {
    pz.filt = { ...pz.filt, [t.dataset.key]: t.dataset.val };
    http.send("PUT", "/api/settings", { filter: pz.filt });
    if (!p || !match(p) || st.result) nextPuzzle(); else renderPuzzlePanel();
    return;
  }
  switch (t.id) {
    case "hint": st.hinted = true; puzzleBoard(); renderPuzzlePanel(); reportView(); break;
    case "skip": case "next": nextPuzzle(); break;
    case "retry": closePreviewSilently(); st.result = null; st.why = null; puzzleBoard(); renderPuzzlePanel(); reportView(); break;
    case "solve":
      closePreviewSilently();
      st.solution = true;
      if (!st.recorded) { st.recorded = true; record(p, false); pz.session.done++; }
      puzzleBoard(); loadBest(); renderPuzzlePanel(); reportView();
      break;
    case "to-study": puzzleToStudy(); break;
    case "ask-claude": {
      const best = playLine(p.fen, [p.best]).plies[0]?.san;
      const r = st.result;
      askClaude(r && !r.ok ? `Почему мой ход ${r.san} здесь плохой? Покажи на доске.` : `Поясни эту задачу: почему здесь лучший ход ${best}? Покажи на доске.`);
      break;
    }
  }
});

function puzzleToStudy() {
  const p = pz.cur, st = pz.st;
  const best = st.best?.line?.plies?.length ? st.best.line.plies.map((x) => x.uci) : [p.best, ...p.moves[p.best][1]];
  const lines = [{ title: "лучший", moves: best }];
  if (p.played !== p.best) lines.push({ title: "в партии", moves: [p.played, ...p.moves[p.played][1]] });
  for (const u of new Set(st.attempts)) if (u !== p.best && u !== p.played) lines.push({ title: "твой ход", moves: [u, ...p.moves[u][1]] });
  post("/api/scene", { title: `${KIND[p.kind]}: ${p.moveNo}-й ход, ход ${SIDE[p._turn]}`, position: p.fen, orientation: p.color, lines, puzzle: p.id })
    .catch((err) => setStatus(String(err.message), true));
}

function renderMeta() {
  const p = pz.cur;
  if (!p || mode !== "puzzle" || lp.on) { $("#meta").innerHTML = ""; return; }
  const d = new Date(p.date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  $("#meta").innerHTML = `<span>${esc(d)} · против ${esc(p.opp)}${p.oppRating ? ` (${p.oppRating})` : ""}</span>
    <span>${esc(p.opening)}</span>
    <a href="https://lichess.org/${esc(p.game)}/${p.color}#${p.ply - 1}" target="_blank" rel="noopener">Партия на Lichess ↗</a>`;
}

function renderStats() {
  const el = $("#stats");
  updateCounts();
  if (!el) return;
  if (ladder.on) { el.innerHTML = ladderHtml(); return; }
  const now = Date.now();
  const pool = pz.list.filter((p) => match(p));
  const seen = pool.filter((p) => pz.prog[p.id]);
  const due = seen.filter((p) => pz.prog[p.id].due <= now).length;
  const learned = seen.filter((p) => (pz.prog[p.id].box || 0) >= 3).length;
  const stat = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  el.innerHTML = [stat(pool.length, "в подборке"), stat(pool.length - seen.length, "не решал"), stat(due, "на повтор"), stat(learned, "выучено"), stat(`${pz.session.ok}/${pz.session.done}`, "за сессию")].join("");
}

function renderFilters() {
  const el = $("#filters");
  if (!el) return;
  const count = (key, val) => pz.list.filter((p) => match(p, { ...pz.filt, [key]: val })).length;
  const group = (key, label, opts) => `<div class="group" role="group" aria-label="${label}"><span class="group-label">${label}</span>${
    opts.map(([v, t]) => `<button type="button" class="chip" data-key="${key}" data-val="${v}" aria-pressed="${pz.filt[key] === v}">${t}<small>${count(key, v)}</small></button>`).join("")}</div>`;
  el.innerHTML =
    group("kind", "Тип", [["all", "Все"], ["blunder", "Не зевни"], ["missed", "Накажи"]]) +
    group("phase", "Стадия", [["all", "Все"], ["opening", "Дебют"], ["middlegame", "Миттельш."], ["endgame", "Эндшпиль"]]) +
    group("color", "Цвет", [["all", "Все"], ["white", "Белые"], ["black", "Чёрные"]]);
}

function renderPuzzle() {
  if (mode !== "puzzle") return;
  if (!lp.ready) lpEnsure().then(() => { if (lp.on && mode === "puzzle") renderPuzzle(); });
  if (lp.on) {
    // no puzzle and none on the way (e.g. the app opened in another mode while the settings were loading): fetch one
    if (lp.cur) lpBoard(); else if (!lp.loading && !lp.st) lpNext();
    renderPuzzlePanel(); renderMeta(); return;
  }
  if (!pz.cur) { const p = pickNext(); if (p) { loadPuzzle(p); return; } }
  if (!preview) puzzleBoard();
  renderPuzzlePanel();
  renderMeta();
  renderEvalBar();
  reportView();
}

// =====================================================================
// CHAT — Claude inside the app
// =====================================================================
const ch = { list: [], cur: null, entries: new Map(), models: [], efforts: [], open: true, delConfirm: false };
const TOOL_LABEL = {
  board_state: "Смотрит на доску", show: "Показывает позицию", add_line: "Добавляет вариант", annotate: "Пишет комментарий на доске",
  goto: "Переводит доску", edit: "Правит дерево вариантов", analyse: "Считает Stockfish", puzzles: "Смотрит задачи",
  run_job: "Запускает обработку", job_status: "Проверяет обработку",
  repertoire_state: "Смотрит репертуар", repertoire_add: "Записывает ходы в репертуар", repertoire_edit: "Правит репертуар",
  repertoire_section: "Правит разделы репертуара", repertoire_notes: "Пишет конспект",
  Read: "Читает файл", Bash: "Команда", Grep: "Ищет в файлах", Glob: "Ищет файлы", Write: "Пишет файл", Edit: "Правит файл",
  WebFetch: "Открывает страницу", WebSearch: "Ищет в интернете", Task: "Помощник", Agent: "Помощник",
};
const HIDDEN_TOOLS = new Set(["ToolSearch", "TodoWrite"]);
const curChat = () => ch.list.find((c) => c.id === ch.cur) || null;

// closed tabs are kept on the server (settings.closed_chats), so the Mac window and the iPad show the same tabs;
// the chats themselves stay either way
let closedChats = new Set();
const saveClosed = () => http.send("PUT", "/api/settings", { closed_chats: [...closedChats] }).catch(() => {});
const openChats = () => ch.list.filter((c) => !closedChats.has(c.id) || c.id === ch.cur);

// The Mac window tells the Claude Limits menu bar app which chat is on screen, so its "waiting for you"
// mark on that chat clears by itself, as for a VS Code window in front (no-op in a browser or on the iPad).
let shownChat;
function reportShownChat() {
  const id = ch.open && !isLive() ? ch.cur || "" : "";
  if (id === shownChat) return;
  shownChat = id;
  try { window.webkit?.messageHandlers?.shownChat?.postMessage(id); } catch {}
}

// a lesson of the repertoire says which section it is about until its first message names it
function chatLabel(c, long = false) {
  const s = repSec(lessonSection(c.id));
  if (!s) return c.title;
  return c.title === "Новый чат" ? `Урок: ${s.name}` : long ? `${c.title} — урок «${s.name}»` : c.title;
}

function renderChatTabs() {
  reportShownChat();
  $("#chat-tabs").innerHTML = openChats().map((c) =>
    `<div class="ctab${c.id === ch.cur ? " on" : ""}" data-chat="${c.id}" title="${esc(chatLabel(c, true))}" role="tab">${c.busy ? '<span class="dot"></span>' : ""}<span class="ctitle">${esc(chatLabel(c))}</span><button type="button" class="cx" data-close="${c.id}" title="Закрыть вкладку">×</button></div>`).join("")
    + `<button type="button" class="ctab add" id="chat-new" title="Новый чат" aria-label="Новый чат">＋</button>`
    + `<button type="button" class="ctab hist" id="chat-hist" title="Все чаты, в том числе закрытые" aria-label="Все чаты"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg></button>`;
}

async function closeChatTab(id) {
  const c = ch.list.find((x) => x.id === id);
  if (!c) return;
  // an empty chat is not worth keeping; "empty" by the server's word (no Claude session yet), since a window
  // loads a chat's entries only when it is opened (an iPad closing unopened tabs deleted real chats)
  if (!c.busy && !c.session_id && !(ch.entries.get(id) || []).length) {
    await post(`/api/chat/${id}/delete`).catch(() => {});
    ch.list = ch.list.filter((x) => x.id !== id);
    ch.entries.delete(id);
  } else {
    closedChats.add(id);
    saveClosed();
    post(`/api/chat/${id}/close`).catch(() => {}); // ends its Claude process, so Claude Limits drops it
  }
  if (ch.cur === id) {
    const rest = ch.list.filter((x) => !closedChats.has(x.id) && x.id !== id);
    await openChat(rest[0]?.id || null);
  } else renderChatTabs();
}

function renderChatsPop() {
  const pop = $("#chats-pop");
  if (pop.hidden) return;
  const date = (t) => new Date(t * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const model = (id) => ch.models.find((m) => m.id === id)?.name || id;
  pop.innerHTML = `<h3>Все чаты</h3>${ch.list.length ? ch.list.map((c) =>
    `<button type="button" class="chat-item${c.id === ch.cur ? " on" : ""}" data-reopen="${c.id}"><b>${esc(c.title)}</b>
      <span>${date(c.updated)} · ${esc(model(c.model))}${closedChats.has(c.id) ? " · закрыт" : ""}</span></button>`).join("") : `<p class="hint">Чатов пока нет.</p>`}`;
  const r = $("#chat").getBoundingClientRect();
  pop.style.top = `${r.top + 40}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left + 8, innerWidth - 420))}px`;
  pop.style.right = "auto";
}

// The chat's model and effort: a chip at the bottom of the chat; it opens a menu with both and «Удалить чат…»
// (deleting asks again inside the same menu)
const modelName = (id) => ch.models.find((m) => m.id === id)?.name || id;
function renderChatOpts() {
  const c = curChat();
  $("#chat-model-btn").hidden = !c;
  if (c) $("#chat-model-text").textContent = `${modelName(c.model)} · ${c.effort}`;
  renderModelPop();
}
function renderModelPop() {
  const pop = $("#model-pop");
  const c = curChat();
  if (!c) pop.hidden = true;
  if (pop.hidden) return;
  pop.innerHTML = ch.delConfirm
    ? `<div class="menu-confirm"><b>Удалить этот чат?</b><span>Разговор пропадёт; его доски останутся в «Разборе».</span>
        <div class="actions"><button type="button" class="btn danger" data-chat-del="yes">Удалить</button><button type="button" class="btn quiet" data-chat-del="no">Отмена</button></div></div>`
    : `<div class="menu-head">Модель</div>
      ${ch.models.map((m) => `<button type="button" class="mi" data-model="${m.id}" aria-checked="${m.id === c.model}" role="menuitemradio">${esc(m.name)}${m.id === c.model ? '<span class="k">✓</span>' : ""}</button>`).join("")}
      <div class="menu-head">Сколько думать</div>
      <div class="seg">${ch.efforts.map((e) => `<button type="button" data-effort="${e}" class="${e === c.effort ? "on" : ""}" aria-pressed="${e === c.effort}">${e}</button>`).join("")}</div>
      <div class="menu-sep"></div>
      <button type="button" class="mi danger" data-chat-del="ask">Удалить чат…</button>`;
  const r = $("#chat-model-btn").getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
}

function entryHtml(e) {
  switch (e.kind) {
    case "user": return `<div class="msg-user" data-eid="${e.id}">${esc(e.text)}</div>`;
    case "assistant": return `<div class="msg-ai rich${e.streaming ? " streaming" : ""}" data-eid="${e.id}">${md(e.text)}</div>`;
    case "tool": {
      const short = e.name.replace(/^mcp__board__/, "");
      if (HIDDEN_TOOLS.has(short)) return "";
      const st = e.status === "running" ? "…" : e.status === "error" ? "✗" : "✓";
      const detail = e.what ? ` — ${esc(e.what)}` : e.name.startsWith("mcp__board__") || !e.summary ? "" : ` <code title="${esc(e.summary)}">${esc(e.summary)}</code>`;
      // a failed step: Claude sees the reason and corrects itself; the raw message is in the tooltip
      const err = e.error ? `<span class="err-text" title="${esc(e.error)}">${e.error.includes("прервано") ? esc(e.error) : "не вышло — Claude поправит"}</span>` : "";
      return `<div class="msg-tool" data-eid="${e.id}"><span class="st${e.status === "error" ? " err" : ""}">${st}</span><span>${esc(TOOL_LABEL[short] || short)}${detail}${err}</span></div>`;
    }
    case "permission": {
      const body = e.state === "pending"
        ? `<div class="actions"><button type="button" class="btn small primary" data-perm="${e.req}" data-allow="1">Разрешить</button>
           ${e.always_label ? `<button type="button" class="btn small" data-perm="${e.req}" data-allow="1" data-always="1">Всегда для ${esc(e.always_label)}</button>` : ""}
           <button type="button" class="btn small" data-perm="${e.req}" data-allow="0">Запретить</button></div>`
        : `<div class="state">${e.state === "allowed" ? "✓ разрешено" : "✗ запрещено"}</div>`;
      const what = e.what ? `<div class="perm-what">${esc(e.what)}</div>` : "";
      const code = e.what ? `<details><summary>показать команду</summary><code>${esc(e.summary)}</code></details>` : `<code>${esc(e.summary)}</code>`;
      return `<div class="msg-perm" data-eid="${e.id}"><div>Claude хочет: <b>${esc(TOOL_LABEL[e.tool] || e.tool)}</b></div>${what}${code}${body}</div>`;
    }
    case "note": return `<div class="msg-note" data-eid="${e.id}">${esc(e.text)}</div>`;
    case "error": return `<div class="msg-error" data-eid="${e.id}">${esc(e.text)}</div>`;
    default: return "";
  }
}

const QUICK = [
  "Поясни позицию на доске",
  "Разбери мою последнюю партию",
  "Какие ошибки я делаю чаще всего?",
  "Скачай новые партии и сделай из них задачи",
];
const quickHtml = () => `<div class="quick">${QUICK.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;

function renderChatLog() {
  const log = $("#chat-log");
  const c = curChat();
  if (!c) {
    const sc = mode === "study" ? scene() : null;
    log.innerHTML = rep.on && mode === "study" ? repChatEmptyHtml() : sc
      ? `<div class="chat-empty"><h3>Чат доски «${esc(sc.title)}»</h3><p>У этой доски пока нет чата. Спроси Claude — разговор останется с этой доской: выберешь её снова, и откроется он.</p></div>`
      : `<div class="chat-empty"><h3>Чат с Claude</h3><p>Claude видит доску, считает Stockfish, показывает варианты и стрелки, разбирает партии и составляет задачи.</p>${quickHtml()}</div>`;
    updateSendButton();
    return;
  }
  const entries = ch.entries.get(c.id) || [];
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = entries.map(entryHtml).join("")
    + (entries.length || c.queued?.length ? "" : `<div class="chat-empty">${rep.data.lessons[c.id] ? repQuickHtml() : quickHtml()}</div>`)
    + chatTailHtml(c);
  if (atBottom || c.busy) log.scrollTop = log.scrollHeight;
  updateSendButton();
}

// below the log: «Claude думает» and the messages waiting for their turn (they enter the log when Claude takes them)
function chatTailHtml(c) {
  const q = c?.queued || [];
  if (!c?.busy && !q.length) return `<div class="chat-tail"></div>`;
  return `<div class="chat-tail">${c.busy ? `<div class="thinking">Claude думает</div>` : ""}`
    + q.map((m) => (m.note ? `<div class="msg-note queued">${esc(m.text)}</div>`
      : `<div class="msg-user queued">${esc(m.text)}${c.busy ? `<div class="qlabel">ждёт своей очереди</div>` : ""}</div>`)).join("")
    + "</div>";
}

function updateSendButton() {
  const c = curChat();
  const btn = $("#chat-send");
  const stop = c?.busy && !$("#chat-text").value.trim();
  btn.textContent = stop ? "Стоп" : "Отправить";
  btn.classList.toggle("stop", !!stop);
}

function renderChat() { renderChatTabs(); renderChatOpts(); renderChatLog(); renderBoardTabs(); }

// follow: in «Разбор» the board follows the chat (its board, or an empty one for a chat without a board)
async function openChat(id, { follow = true } = {}) {
  if (id && closedChats.delete(id)) saveClosed();
  ch.cur = id;
  ch.delConfirm = false;
  if (id && !ch.entries.has(id)) {
    try { const d = await http.get(`/api/chat/${id}`); ch.entries.set(id, d.entries); } catch { ch.entries.set(id, []); }
  }
  try { localStorage.setItem("chat.cur", id || ""); } catch {}
  renderChat();
  if (follow) followChat();
}

// board: the chat is made for this board (the server returns the board's own chat if it has one)
async function newChat(board = null) {
  if (rep.on && mode === "study" && repSec() && (!board || board.rep)) return newLesson();
  const c = curChat();
  const meta = await post("/api/chat", { model: c?.model, effort: c?.effort, scene: board?.rep ? undefined : board?.id });
  ch.list = [meta, ...ch.list.filter((x) => x.id !== meta.id)];
  if (board) board.chat = meta.id; // the server's scene event confirms it
  await openChat(meta.id, { follow: !board });
  $("#chat-text").focus();
  return meta;
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  if (!curChat()) await newChat(mode === "study" ? scene() : null);
  $("#chat-text").value = "";
  autosize();
  updateSendButton();
  await post(`/api/chat/${ch.cur}/send`, { text }).catch((err) => setStatus(String(err.message), true));
}

// a message about a board goes to that board's chat (made on first use), even when it is not on screen
// extra: { key, supersedes } — see askAboutUserLine
async function sendToChat(text, sc = mode === "study" ? scene() : null, extra = {}) {
  if (isLive()) return; // no Claude during a live game
  setChatOpen(true);
  if (sc?.rep) sc = null; // about the repertoire: the open chat (in a section: its lesson)
  let cid;
  try {
    if (sc && sc.id === study.id && mode === "study") {
      if (!chatOf(sc)) await newChat(sc); else if (ch.cur !== sc.chat) await openChat(sc.chat, { follow: false });
      cid = ch.cur;
    } else if (sc) {
      cid = chatOf(sc);
      if (!cid) {
        const meta = await post("/api/chat", { scene: sc.id, model: curChat()?.model, effort: curChat()?.effort });
        ch.list = [meta, ...ch.list.filter((x) => x.id !== meta.id)];
        sc.chat = cid = meta.id;
      }
    } else {
      if (!curChat()) await newChat();
      cid = ch.cur;
    }
    await post(`/api/chat/${cid}/send`, { text, ...extra });
  } catch (err) { setStatus(String(err.message), true); }
}

function askClaude(text) {
  if (isLive()) return;
  setChatOpen(true);
  // a puzzle is a new topic: a fresh chat, not one that is about its boards
  if (mode !== "study" && boardsOf(ch.cur).length) openChat(null, { follow: false });
  const ta = $("#chat-text");
  ta.value = text;
  autosize();
  ta.focus();
  updateSendButton();
}

function autosize() {
  const ta = $("#chat-text");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
}

function setChatOpen(open) {
  ch.open = open;
  $("#layout").classList.toggle("no-chat", !open || isLive());
  $("#chat-toggle").classList.toggle("on", open);
  $("#chat-toggle").setAttribute("aria-pressed", String(open));
  try { localStorage.setItem("chat.open", open ? "1" : "0"); } catch {}
  layout();
  reportShownChat();
}

$("#chat-tabs").addEventListener("click", (e) => {
  const x = e.target.closest("[data-close]");
  if (x) { e.stopPropagation(); closeChatTab(x.dataset.close); return; }
  const b = e.target.closest("button, .ctab");
  if (!b) return;
  if (b.id === "chat-new") newChat();
  else if (b.id === "chat-hist") { e.stopPropagation(); const pop = $("#chats-pop"); pop.hidden = !pop.hidden; renderChatsPop(); }
  else if (b.dataset.chat) openChat(b.dataset.chat);
});
$("#chat-tabs").addEventListener("auxclick", (e) => { // middle click closes a tab, as in a browser
  const t = e.target.closest(".ctab[data-chat]");
  if (t && e.button === 1) closeChatTab(t.dataset.chat);
});
$("#chats-pop").addEventListener("click", (e) => {
  e.stopPropagation();
  const b = e.target.closest("[data-reopen]");
  if (!b) return;
  $("#chats-pop").hidden = true;
  setChatOpen(true);
  openChat(b.dataset.reopen);
});
document.addEventListener("click", (e) => { if (!e.target.closest("#chats-pop, #chat-hist")) $("#chats-pop").hidden = true; });
$("#chat-log").addEventListener("click", (e) => {
  const q = e.target.closest("[data-q]");
  if (q) { sendChat(q.dataset.q); return; }
  const p = e.target.closest("[data-perm]");
  if (p) post(`/api/chat/${ch.cur}/permission`, { req: p.dataset.perm, allow: p.dataset.allow === "1", always: !!p.dataset.always });
});
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-text").value;
  if (!text.trim() && curChat()?.busy) { post(`/api/chat/${ch.cur}/stop`); return; }
  sendChat(text);
});
$("#chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});
$("#chat-text").addEventListener("input", () => { autosize(); updateSendButton(); });
$("#chat-model-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#model-pop");
  pop.hidden = !pop.hidden;
  ch.delConfirm = false;
  renderModelPop();
});
$("#model-pop").addEventListener("click", async (e) => {
  e.stopPropagation();
  const b = e.target.closest("button");
  const c = curChat();
  if (!b || !c) return;
  if (b.dataset.model) { c.model = b.dataset.model; post(`/api/chat/${c.id}/config`, { model: c.model }); renderChatOpts(); }
  else if (b.dataset.effort) { c.effort = b.dataset.effort; post(`/api/chat/${c.id}/config`, { effort: c.effort }); renderChatOpts(); }
  else if (b.dataset.chatDel === "ask" || b.dataset.chatDel === "no") { ch.delConfirm = b.dataset.chatDel === "ask"; renderModelPop(); }
  else if (b.dataset.chatDel === "yes") {
    const id = c.id;
    ch.delConfirm = false;
    $("#model-pop").hidden = true;
    await post(`/api/chat/${id}/delete`);
    ch.entries.delete(id);
    ch.list = ch.list.filter((x) => x.id !== id);
    // in «Разбор» the board stays, now without a chat; elsewhere the next chat opens
    openChat(mode === "study" ? null : ch.list[0]?.id || null, { follow: false });
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#model-pop, #chat-model-btn")) { $("#model-pop").hidden = true; ch.delConfirm = false; }
});
$("#chat-toggle").addEventListener("click", () => setChatOpen(!ch.open));

let deltaFrame = null;
function onChatEvent(ev) {
  if (ev.type === "chat_list") {
    ch.list = ev.chats;
    if (ch.cur && !ch.list.some((c) => c.id === ch.cur)) ch.cur = mode === "study" ? null : ch.list[0]?.id || null;
    renderChatTabs();
    renderChatOpts();
    const log = $("#chat-log");
    const tail = $(".chat-tail", log);
    if (tail) {
      const html = chatTailHtml(curChat());
      if (tail.outerHTML !== html) {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        tail.outerHTML = html;
        if (atBottom || curChat()?.busy) log.scrollTop = log.scrollHeight;
      }
    }
    updateSendButton();
    return;
  }
  const list = ch.entries.get(ev.chat);
  if (!list) return;
  if (ev.type === "chat_entry") {
    const i = list.findIndex((x) => x.id === ev.entry.id);
    if (i >= 0) list[i] = ev.entry; else list.push(ev.entry);
    // a waiting message has just entered the log: take it off the queue now, the next chat_list confirms it
    const meta = ch.list.find((c) => c.id === ev.chat);
    if (i < 0 && meta?.queued?.length && (ev.entry.kind === "user" || ev.entry.kind === "note")) {
      const j = meta.queued.findIndex((m) => m.text === ev.entry.text);
      if (j >= 0) meta.queued.splice(j, 1);
    }
    if (ev.chat !== ch.cur) return;
    const el = $(`[data-eid="${ev.entry.id}"]`, $("#chat-log"));
    if (el) el.outerHTML = entryHtml(ev.entry) || "<span hidden></span>";
    else renderChatLog();
  } else if (ev.type === "chat_delta") {
    const e = list.find((x) => x.id === ev.entry);
    if (!e) return;
    e.text += ev.text;
    if (ev.chat !== ch.cur || deltaFrame) return;
    deltaFrame = requestAnimationFrame(() => {
      deltaFrame = null;
      const el = $(`[data-eid="${e.id}"]`, $("#chat-log"));
      if (!el) return;
      el.innerHTML = md(e.text);
      const log = $("#chat-log");
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight;
    });
  }
}

// =====================================================================
// JOBS — fetch / analyse games, build puzzles
// =====================================================================
// The chip in the header shows only while a job runs, then its result for a few seconds; a failure stays until the
// log is opened. Starting a job: the ⋯ menu in the header (or ask Claude).
const jobsState = { list: [], kinds: {}, endedAt: 0, failSeen: null };
const JOB_STATUS = { running: "идёт", done: "готово", failed: "ошибка", cancelled: "остановлено" };
const JOB_SHOW_MS = 8000;

function renderJobChip() {
  const run = jobsState.list.find((j) => j.status === "running");
  const last = run || jobsState.list[jobsState.list.length - 1];
  const chip = $("#job-chip");
  const failed = last?.status === "failed" && jobsState.failSeen !== last.id;
  chip.hidden = !(run || failed || (last && Date.now() - jobsState.endedAt < JOB_SHOW_MS));
  chip.classList.toggle("running", !!run);
  chip.classList.toggle("failed", !!failed);
  const tail = last?.tail?.filter((l) => l.trim()).slice(-1)[0] || "";
  $("#job-text").textContent = run ? `${run.title}${tail ? `: ${tail}` : ""}` : last ? `${last.title}: ${JOB_STATUS[last.status] || last.status}` : "";
}

// ⋯ in the header: the jobs over the user's games («Обновить всё» first) and their log
function renderAppMenu() {
  const menu = $("#app-menu");
  if (menu.hidden) return;
  const run = jobsState.list.some((j) => j.status === "running");
  const kinds = Object.entries(jobsState.kinds).sort(([a], [b]) => (b === "update") - (a === "update"));
  menu.innerHTML = `<div class="menu-head">Мои партии</div>
    ${kinds.map(([k, t]) => `<button type="button" class="mi" data-job="${k}"${run ? " disabled" : ""}>${esc(t)}</button>`).join("")}
    <div class="menu-sep"></div>
    <button type="button" class="mi" data-joblog="1"${jobsState.list.length ? "" : " disabled"}>Журнал обработки</button>`;
  const r = $("#app-menu-btn").getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
}
$("#app-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#app-menu");
  m.hidden = !m.hidden;
  $("#jobs-pop").hidden = true;
  renderAppMenu();
});
$("#app-menu").addEventListener("click", async (e) => {
  e.stopPropagation();
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  $("#app-menu").hidden = true;
  if (b.dataset.job) await post("/api/job", { kind: b.dataset.job }).catch((err) => setStatus(String(err.message), true));
  else if (b.dataset.joblog) openJobsPop();
});
document.addEventListener("click", (e) => { if (!e.target.closest("#app-menu, #app-menu-btn")) $("#app-menu").hidden = true; });

function openJobsPop() {
  const pop = $("#jobs-pop");
  pop.hidden = false;
  const last = jobsState.list[jobsState.list.length - 1];
  if (last?.status === "failed") jobsState.failSeen = last.id;
  renderJobsPop();
  renderJobChip();
}

function renderJobsPop() {
  const pop = $("#jobs-pop");
  if (pop.hidden) return;
  const run = jobsState.list.find((j) => j.status === "running");
  const last = run || jobsState.list[jobsState.list.length - 1];
  pop.innerHTML = `<h3>Обработка партий</h3>
    ${last ? `<div><b>${esc(last.title)}</b> — ${esc(JOB_STATUS[last.status] || last.status)}, ${last.seconds} с</div>
      <pre>${esc((last.tail || []).join("\n"))}</pre>
      ${run ? `<div class="row"><button type="button" class="btn" data-stop="${run.id}">Остановить</button></div>` : ""}`
    : `<p class="hint">Пока ничего не запускалось. Запустить — в меню ⋯ вверху или попросить Claude в чате.</p>`}`;
}

$("#job-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#jobs-pop").hidden) openJobsPop(); else $("#jobs-pop").hidden = true;
});
$("#jobs-pop").addEventListener("click", async (e) => {
  e.stopPropagation();
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.job) await post("/api/job", { kind: b.dataset.job }).catch((err) => setStatus(String(err.message), true));
  if (b.dataset.stop) await post(`/api/job/${b.dataset.stop}/stop`);
});
document.addEventListener("click", (e) => { if (!e.target.closest("#jobs-pop, #job-chip")) $("#jobs-pop").hidden = true; });

// =====================================================================
// PLAY — live games on Lichess (Board API; the server side is coach/live.py). While a game is on,
// nothing that could help is on screen — no engine, analysis board, puzzles or Claude (Lichess fair
// play); the server refuses those too. After the game it opens in the analysis board.
// =====================================================================
const play = { st: null, ply: null, flipped: false, sent: null, premo: null, show: null, confirm: null, tab: "seek", rated: true, ai: { level: 3, tc: "10+0", color: "random" } };
try { const p = JSON.parse(localStorage.getItem("play.prefs") || "{}"); Object.assign(play, { tab: p.tab || play.tab, rated: p.rated ?? play.rated, ai: { ...play.ai, ...p.ai } }); } catch {}
const savePlayPrefs = () => { try { localStorage.setItem("play.prefs", JSON.stringify({ tab: play.tab, rated: play.rated, ai: play.ai })); } catch {} };
const isLive = () => !!play.st?.live;
const pgame = () => play.st?.game || null;
const SIDE_NOM = { white: "Белые", black: "Чёрные" };
const turnNow = (g) => turnOf(g.moves.at(-1)?.fen || g.startFen);
const tcText = (g) => (g.clock ? `${g.clock.initial / 60000}+${g.clock.increment / 1000}` : "");
const perfOf = (t, i) => (t * 60 + 40 * i < 1500 ? "Рапид" : "Классика");
const loginLink = (label = "Подключить Lichess", cls = "btn primary") => `<a class="${cls}" href="/api/lichess/login" target="_blank" rel="noopener">${label}</a>`;

function playResult(g) {
  if (g.status === "aborted" || g.status === "noStart") return { head: "Партия отменена", why: g.status === "noStart" ? "первый ход не сделан вовремя" : "", cls: "info" };
  const loser = g.winner ? other(g.winner) : null;
  const why = {
    mate: "мат", resign: loser && `${SIDE_NOM[loser]} сдались`, stalemate: "пат", draw: "по согласию или повторению",
    outoftime: loser && `у ${loser === "white" ? "белых" : "чёрных"} кончилось время`, timeout: loser && `${SIDE_NOM[loser]} покинули партию`,
    insufficientMaterialClaim: "мало материала для мата", cheat: "партия остановлена Lichess",
  }[g.status] || "";
  if (!g.winner) return { head: "Ничья", why, cls: "info" };
  return g.winner === g.color ? { head: "Победа", why, cls: "ok" } : { head: "Поражение", why, cls: "fail" };
}

function clockMs(g, side) {
  const base = side === "white" ? g.wtime : g.btime;
  if (base == null) return null;
  const running = g.playing && g.moves.length >= 2 && turnNow(g) === side; // Lichess starts the clocks after both first moves
  return running ? Math.max(0, base - (Date.now() - g.at)) : base;
}
function fmtClock(ms) {
  if (ms == null) return "–:––";
  if (ms < 10000) return `0:0${(Math.floor(ms / 100) / 10).toFixed(1)}`;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
const fmtDur = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// ---- sound: Lichess's standard set (vendor/sound): moves, captures, a new game, low time ----
// Lichess plays nothing at the end of a game in this set, so neither do we.
const SOUND_FILE = { move: "Move", capture: "Capture", start: "GenericNotify", low: "LowTime" };
const soundBuf = {};
let actx = null;
function loadSound(name) {
  soundBuf[name] ||= fetch(`/static/vendor/sound/${name}.mp3`).then((r) => r.arrayBuffer()).then((b) => actx.decodeAudioData(b)).catch(() => null);
  return soundBuf[name];
}
async function sound(kind) {
  if (!SOUND_FILE[kind]) return;
  try {
    actx ||= new AudioContext();
    if (actx.state === "suspended") await actx.resume();
    const buf = await loadSound(SOUND_FILE[kind]);
    if (!buf) return;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(actx.destination);
    src.start();
  } catch {}
}
const moveSound = (san) => sound(san?.includes("x") ? "capture" : "move");
// browsers start audio only after a click: get it ready on the first one
document.addEventListener("pointerdown", () => {
  try { actx ||= new AudioContext(); actx.resume(); Object.values(SOUND_FILE).forEach(loadSound); } catch {}
}, { once: true });

// the clock turns red and LowTime sounds below Lichess's threshold: 1/8 of the initial time, 10–60 s
const lowMs = (g) => 1000 * Math.min(60, Math.max(10, (g.clock?.initial ?? 600000) / 8000));

// ---- board ----
const playFen = (g, ply) => (ply > 0 ? g.moves[ply - 1].fen : g.startFen);
function playBoard() {
  const g = pgame();
  if (!g) { setBoard({ fen: START_FEN, orientation: boardOrientation() }); return; }
  const n = g.moves.length;
  const ply = play.ply == null || play.ply > n ? n : play.ply;
  if (play.sent && ply === n) return; // our move is on its way to Lichess: keep the board as the user left it
  if (promo) return; // the user is picking a promotion piece: redrawn once they have
  const fen = playFen(g, ply);
  const live = ply === n && g.playing && g.boardOk && g.loaded;
  const mine = live && turnOf(fen) === g.color;
  setBoard({
    fen, orientation: boardOrientation(), lastMove: ply ? sq(g.moves[ply - 1].uci) : undefined,
    movable: live ? { color: g.color, dests: mine ? legalDests(fen) : new Map(), after: onPlayMove } : null,
    premove: live,
  });
}

async function onPlayMove(orig, dest, meta) {
  let g = pgame();
  if (!g?.playing) return;
  let promotion = "q";
  if (isPromotion(playFen(g, g.moves.length), orig, dest)) {
    const pre = play.premo; // a premove: the piece was picked when it was set
    play.premo = null;
    if (meta?.premove && pre?.orig === orig && pre?.dest === dest) promotion = pre.piece;
    else if (!meta?.premove) {
      const n = g.moves.length;
      promotion = await choosePromotion(dest, g.color);
      g = pgame();
      if (!promotion || !g?.playing || g.moves.length !== n) { playBoard(); return; }
    }
  }
  const c = new Chess(playFen(g, g.moves.length));
  let m;
  try { m = c.move({ from: orig, to: dest, promotion }); } catch { playBoard(); return; }
  moveSound(m.san);
  play.sent = { game: g.id, ply: g.moves.length };
  try {
    await post("/api/lichess/move", { game: g.id, uci: m.from + m.to + (m.promotion || "") });
  } catch (err) {
    play.sent = null;
    setStatus(String(err.message), true);
    playBoard();
  }
}

function playStep(dir) {
  const g = pgame();
  if (!g) return;
  const n = g.moves.length;
  const p = play.ply ?? n;
  const to = { first: 0, prev: Math.max(0, p - 1), next: Math.min(n, p + 1), last: n }[dir] ?? p;
  play.ply = to >= n ? null : to;
  renderPlay();
}

// ---- panel ----
function playerHtml(g, side) {
  const p = g[side];
  const ms = clockMs(g, side);
  const run = g.playing && g.moves.length >= 2 && turnNow(g) === side;
  const low = g.playing && ms != null && ms < lowMs(g);
  const rating = p.rating ? ` <small>${p.rating}${p.provisional ? "?" : ""}</small>` : "";
  return `<div class="pl${run ? " run" : ""}${low ? " low" : ""}${p.me ? " me" : ""}">
    <span class="pl-name">${p.title ? `<span class="ttl">${esc(p.title)}</span> ` : ""}${esc(p.name)}${rating}</span>
    <b class="clock" data-clock="${side}">${fmtClock(ms)}</b></div>`;
}

function playMovesHtml(g, ply) {
  if (!g.moves.length) {
    return `<p class="hint">Ходов пока нет. ${g.color === "white" ? "Твой первый ход." : "Ждём первый ход белых."}</p>`;
  }
  const root = { id: "g0", children: [] };
  let node = root;
  g.moves.forEach((m, i) => {
    const n = { id: `g${i + 1}`, san: m.san, num: m.num, uci: m.uci, fen: m.fen, glyph: "", label: "", comment: "", children: [] };
    node.children.push(n);
    node = n;
  });
  return treeHtml(root, `g${ply}`);
}

function playStatusHtml(g, ply) {
  const n = g.moves.length;
  if (!g.playing) {
    const r = playResult(g);
    const counted = g.rated && g.ratingDiff != null && g.status !== "aborted" && g.status !== "noStart";
    const d = counted ? ` Рейтинг: ${g.ratingDiff >= 0 ? "+" : ""}${g.ratingDiff}.` : "";
    return `<div class="result ${r.cls}"><h3>${esc(r.head)}</h3>${r.why || d ? `<p>${esc(r.why ? r.why[0].toUpperCase() + r.why.slice(1) + "." : "")}${esc(d)}</p>` : ""}</div>${repAfterGameHtml(g)}`;
  }
  if (!g.boardOk) {
    return `<div class="result info"><h3>Партия идёт на lichess.org</h3>
      <p>Её начали на сайте с контролем, который сторонние программы играть не могут. Играй в браузере: <a href="${esc(g.url)}" target="_blank" rel="noopener">открыть партию</a>.</p></div>`;
  }
  if (!g.loaded) return `<p class="hint">Подключаюсь к партии…</p>`;
  let h = "";
  if (ply < n) h += `<p class="hint">Смотришь позицию после ${ply ? `${esc(g.moves[ply - 1].num)}${esc(g.moves[ply - 1].san)}` : "начала"} · <button type="button" class="link-btn" id="to-live">к текущей позиции</button></p>`;
  if (g.drawOffer && g.drawOffer !== g.color) {
    h += `<div class="offer"><span>Соперник предлагает ничью</span><button type="button" class="btn small" data-act="draw">Принять</button><button type="button" class="btn small" data-act="decline">Отклонить</button></div>`;
  } else if (g.drawOffer === g.color) {
    h += `<p class="hint">Ничья предложена — ждём ответа соперника.</p>`;
  }
  if (g.gone?.gone) {
    const left = g.gone.claimIn == null ? null : Math.max(0, Math.ceil(g.gone.claimIn - (Date.now() - g.gone.at) / 1000));
    h += `<div class="offer"><span>Соперник покинул партию.${left ? ` Победу можно забрать через <b id="gone-in">${left}</b> с.` : ""}</span>${left === 0 ? `<button type="button" class="btn small" data-act="claim">Забрать победу</button>` : ""}</div>`;
  }
  const mine = turnNow(g) === g.color;
  h += `<div class="turn${mine ? " mine" : ""}">${mine ? "Твой ход" : "Ход соперника"}</div>`;
  return h;
}

function playActionsHtml(g) {
  if (g.playing && g.boardOk) {
    if (g.moves.length < 2) return `<div class="actions"><button type="button" class="btn" data-act="abort">Отменить партию</button></div>`;
    const sure = play.confirm === "resign";
    return `<div class="actions">
      <button type="button" class="btn" data-act="draw" ${g.drawOffer === g.color ? "disabled" : ""}>Предложить ничью</button>
      <button type="button" class="btn${sure ? " confirm" : ""}" data-act="resign">${sure ? "Точно сдаться?" : "Сдаться"}</button></div>`;
  }
  if (g.playing) return "";
  return `<div class="actions">
    ${g.moves.length ? `<button type="button" class="btn primary" id="review">Разобрать в анализе</button><button type="button" class="btn" id="review-claude">Разобрать с Claude</button>` : ""}
    <button type="button" class="btn quiet" id="new-game">Новая партия</button></div>`;
}

const RULES = `<p class="hint rules">Во время партии в приложении нет ни анализа, ни Stockfish, ни задач, ни чата с Claude: Lichess запрещает любую помощь со стороны. Разбор — после партии.</p>`;

function playErrHtml(s) {
  if (!s.error || s.error === "need_scope") return "";
  return `<p class="lerr">${esc(s.error)}</p>`;
}

function connectHtml(s) {
  const scope = s.connected && !s.scopeOk;
  return `<div class="lobby">
    <h2>Игра на Lichess</h2>
    ${scope
      ? `<p>Вход в Lichess есть, но без права играть партии. Подключи Lichess заново и разреши «Play games with the board API».</p>`
      : `<p>Приложение подключится к твоему аккаунту Lichess и будет передавать ходы. Ходишь ты сам, как на сайте; партии идут в твой рейтинг.</p>`}
    ${loginLink(scope ? "Подключить заново" : "Подключить Lichess")}
    <p class="hint">Откроется браузер. Lichess спросит, разрешить ли приложению «chess-coach-local» играть партии и решать задачи от твоего имени — подтверди и вернись сюда.</p>
    <details class="token-way"><summary>Другой способ: вставить личный токен</summary>
      <p class="hint">Создай токен на <a href="https://lichess.org/account/oauth/token/create?scopes[]=board:play&scopes[]=puzzle:read&scopes[]=puzzle:write&description=%D0%A8%D0%B0%D1%85%D0%BC%D0%B0%D1%82%D0%BD%D1%8B%D0%B9%20%D1%82%D1%80%D0%B5%D0%BD%D0%B5%D1%80" target="_blank" rel="noopener">странице Lichess</a> (нужные галочки там уже стоят), скопируй и вставь сюда.</p>
      <form class="newpos" id="token-form"><input id="token-input" placeholder="lip_…" autocomplete="off" spellcheck="false"><button class="btn small primary" type="submit">Сохранить</button></form>
    </details>
    ${playErrHtml(s)}${RULES}${historyHtml()}</div>`;
}

function lobbyHtml(s) {
  const head = `<div class="acct"><span>Lichess: <b>${esc(s.user || "?")}</b>${s.stream ? "" : " · подключаюсь…"}</span>
    <button type="button" class="link-btn${play.confirm === "logout" ? " confirm" : ""}" id="li-logout">${play.confirm === "logout" ? "точно отключить?" : "отключить"}</button></div>`;
  if (s.seek) {
    const k = s.seek;
    return `<div class="lobby">${head}
      <div class="seeking"><span class="spin"></span><div><b>Ищу соперника: ${k.time}+${k.increment}, ${k.rated ? "рейтинговая" : "товарищеская"}</b>
        <span id="seek-time">${fmtDur(Date.now() - k.since)}</span></div><button type="button" class="btn small" id="seek-cancel">Отменить</button></div>
      ${playErrHtml(s)}${RULES}</div>`;
  }
  const tabs = `<div class="pmode" role="group" aria-label="С кем играть">
    <button type="button" class="chip" data-ptab="seek" aria-pressed="${play.tab === "seek"}">С игроком</button>
    <button type="button" class="chip" data-ptab="ai" aria-pressed="${play.tab === "ai"}">С компьютером Lichess</button></div>`;
  let body;
  if (play.tab === "ai") {
    const chips = (key, opts) => opts.map(([v, t]) => `<button type="button" class="chip" data-ai="${key}=${v}" aria-pressed="${String(play.ai[key]) === String(v)}">${t}</button>`).join("");
    body = `<div class="filters">
        <div class="group"><span class="group-label">Уровень</span>${chips("level", [1, 2, 3, 4, 5, 6, 7, 8].map((x) => [x, x]))}</div>
        <div class="group"><span class="group-label">Время</span>${chips("tc", s.aiPresets.map(([t, i]) => [`${t}+${i}`, `${t}+${i}`]))}</div>
        <div class="group"><span class="group-label">Цвет</span>${chips("color", [["random", "Случайно"], ["white", "Белые"], ["black", "Чёрные"]])}</div></div>
      <button type="button" class="btn primary" id="ai-go">Играть с компьютером</button>
      <p class="hint">Без рейтинга. Уровень 1 — самый слабый, 8 — самый сильный.</p>`;
  } else {
    body = `<div class="tc-grid">${s.seekPresets.map(([t, i]) =>
        `<button type="button" class="tc" data-seek="${t}+${i}"><b>${t}+${i}</b><span>${perfOf(t, i)}</span></button>`).join("")}</div>
      <div class="group"><button type="button" class="chip" data-rated="1" aria-pressed="${play.rated}">Рейтинговая</button>
        <button type="button" class="chip" data-rated="0" aria-pressed="${!play.rated}">Товарищеская</button></div>
      <p class="hint">Нажми на контроль времени — Lichess найдёт соперника. Блиц и пулю Lichess не даёт играть из сторонних программ.</p>`;
  }
  return `<div class="lobby">${head}${tabs}${body}${playErrHtml(s)}${RULES}${historyHtml()}</div>`;
}

function gameHtml(g, s) {
  const n = g.moves.length;
  const ply = play.ply == null || play.ply > n ? n : play.ply;
  const bottom = boardOrientation();
  return `<div class="pgame">
    ${playerHtml(g, other(bottom))}
    <div class="pmoves" id="pmoves">${playMovesHtml(g, ply)}</div>
    ${playStatusHtml(g, ply)}
    ${playerHtml(g, bottom)}
    ${playActionsHtml(g)}
    ${playErrHtml(s)}${g.playing ? RULES : ""}</div>`;
}

function renderPlayPanel() {
  if (mode !== "play") return;
  const panel = $("#panel");
  const s = play.st, g = pgame();
  if (!s) { panel.innerHTML = `<p class="hint">Загружаю…</p>`; return; }
  if (g && (g.playing || play.show === g.id)) {
    panel.innerHTML = gameHtml(g, s);
    const box = $("#pmoves");
    const act = $(".tview .active", box);
    if (act) scrollNearest(act, box); else if (box) box.scrollTop = box.scrollHeight;
    return;
  }
  panel.innerHTML = !s.connected || !s.scopeOk ? connectHtml(s) : lobbyHtml(s);
}

function renderPlayMeta() {
  const g = pgame();
  if (mode !== "play") return;
  if (!g || !(g.playing || play.show === g.id)) { $("#meta").innerHTML = ""; return; }
  $("#meta").innerHTML = `<span>${g.rated ? "Рейтинговая" : "Товарищеская"} · ${esc(g.perf || "")} ${esc(tcText(g))}</span>
    <a href="${esc(g.url)}" target="_blank" rel="noopener">Партия на Lichess ↗</a>`;
}

function renderPlay() {
  if (mode !== "play") return;
  if (!preview) playBoard();
  renderPlayPanel();
  renderPlayMeta();
  const g = pgame();
  const n = g?.moves.length || 0;
  const ply = play.ply ?? n;
  $("[data-nav=first]").disabled = $("[data-nav=prev]").disabled = !g || ply === 0;
  $("[data-nav=last]").disabled = $("[data-nav=next]").disabled = !g || ply >= n;
  renderEvalBar();
  updateCounts();
  reportView();
}

// clocks, the seek timer and the "claim victory" countdown tick without redrawing the panel
setInterval(() => {
  if (mode !== "play") return;
  const g = pgame();
  if (g) {
    for (const el of $$("[data-clock]")) {
      const ms = clockMs(g, el.dataset.clock);
      el.textContent = fmtClock(ms);
      el.parentElement.classList.toggle("low", g.playing && ms != null && ms < lowMs(g));
    }
    // LowTime once each time my clock drops below the threshold (an increment can lift it back)
    const mine = clockMs(g, g.color);
    if (g.playing && mine != null) {
      if (mine < lowMs(g) && play.lowSounded !== g.id) { play.lowSounded = g.id; sound("low"); }
      else if (mine > lowMs(g) + 5000 && play.lowSounded === g.id) play.lowSounded = null;
    }
    const gone = $("#gone-in");
    if (gone && g.gone) {
      const left = Math.max(0, Math.ceil(g.gone.claimIn - (Date.now() - g.gone.at) / 1000));
      if (left === 0) renderPlayPanel(); else gone.textContent = left;
    }
  }
  const st = $("#seek-time");
  if (st && play.st?.seek) st.textContent = fmtDur(Date.now() - play.st.seek.since);
}, 200);

async function liPost(url, b) {
  try { return await post(url, b); } catch (err) { setStatus(String(err.message), true); setTimeout(() => setStatus(""), 6000); return null; }
}

$("#panel").addEventListener("click", async (e) => {
  if (mode !== "play") return;
  const t = e.target.closest("button, .tm[data-id], .vm[data-id]");
  if (!t) return;
  const g = pgame();
  if (t.dataset.id) {
    const i = Number(t.dataset.id.slice(1));
    play.ply = !g || i >= g.moves.length ? null : i;
    renderPlay();
    return;
  }
  if (t.dataset.hist) { openReview(t.dataset.hist); return; }
  if (t.dataset.ptab) { play.tab = t.dataset.ptab; savePlayPrefs(); renderPlayPanel(); return; }
  if (t.dataset.rated) { play.rated = t.dataset.rated === "1"; savePlayPrefs(); renderPlayPanel(); return; }
  if (t.dataset.ai) {
    const [k, v] = t.dataset.ai.split("=");
    play.ai[k] = k === "level" ? Number(v) : v;
    savePlayPrefs();
    renderPlayPanel();
    return;
  }
  if (t.dataset.seek) {
    const [time, increment] = t.dataset.seek.split("+").map(Number);
    await liPost("/api/lichess/seek", { time, increment, rated: play.rated });
    return;
  }
  if (t.dataset.act && g) {
    if (t.dataset.act === "resign" && play.confirm !== "resign") { // a second click resigns
      play.confirm = "resign";
      renderPlayPanel();
      setTimeout(() => { if (play.confirm === "resign") { play.confirm = null; renderPlayPanel(); } }, 3000);
      return;
    }
    play.confirm = null;
    await liPost("/api/lichess/action", { game: g.id, action: t.dataset.act });
    return;
  }
  switch (t.id) {
    case "seek-cancel": await liPost("/api/lichess/seek/cancel"); break;
    case "ai-go": {
      const [time, increment] = play.ai.tc.split("+").map(Number);
      await liPost("/api/lichess/ai", { level: play.ai.level, time, increment, color: play.ai.color });
      break;
    }
    case "li-logout":
      if (play.confirm !== "logout") {
        play.confirm = "logout";
        renderPlayPanel();
        setTimeout(() => { if (play.confirm === "logout") { play.confirm = null; renderPlayPanel(); } }, 3000);
        return;
      }
      play.confirm = null;
      await liPost("/api/lichess/logout");
      break;
    case "to-live": play.ply = null; renderPlay(); break;
    case "new-game": play.show = null; play.ply = null; play.hist = null; renderPlay(); break;
    case "hist-more": play.histLimit = (play.histLimit || 30) + 30; loadHistory(); break;
    case "hist-refresh":
      await liPost("/api/history/refresh");
      if (play.hist) play.hist.fetching = true;
      renderPlayPanel();
      break;
    case "review": reviewGame(false); break;
    case "review-claude": reviewGame(true); break;
  }
});
$("#panel").addEventListener("submit", async (e) => {
  if (e.target.id !== "token-form") return;
  e.preventDefault();
  const r = await liPost("/api/lichess/token", { token: $("#token-input").value });
  if (r) onLive(r);
});

// ---- reviews: a game of the user's (just played or from the history) on the analysis board, with
// Stockfish's ?! / ? / ?? and better lines (coach/review.py); Claude can take over once it is done ----
const pendingClaude = new Map(); // diagram id -> the message for Claude, sent when Stockfish has finished

function claudeReviewText(sc) {
  return `Разбери мою партию на доске — диаграмма «${sc.title}»${sc.game?.url ? `, ${sc.game.url}` : ""}. ` +
    "Stockfish уже отметил в ней неточности, ошибки и зевки (?!, ?, ??) и добавил лучшие варианты. " +
    "Объясни по-человечески мои главные ошибки: что я упустил, какая была идея у лучшего хода и как думать в таких позициях. Покажи на доске.";
}

function checkPendingClaude(sc) {
  if (sc?.review?.state === "done" && pendingClaude.has(sc.id)) {
    pendingClaude.delete(sc.id);
    sendToChat(claudeReviewText(sc), sc);
  }
}

async function openReview(gameId, withClaude = false) {
  let r;
  try { r = await post("/api/review", { game: gameId }); } catch (err) { setStatus(String(err.message), true); return; }
  await waitScene(r.scene);
  if (!study.scenes.some((s) => s.id === r.scene)) study.scenes = (await http.get("/api/state")).study.scenes; // the event was missed
  closePreviewSilently();
  study.id = r.scene;
  study.node = "root";
  if (withClaude) pendingClaude.set(r.scene, true);
  if (mode !== "study") setMode("study", { follow: "board" }); else { renderStudy(); followBoard(); }
  checkPendingClaude(scene());
}

function reviewGame(withClaude) {
  const g = pgame();
  if (g?.moves.length && !g.playing) openReview(g.id, withClaude);
}

// ---- the user's games (lichess/games.ndjson in the data folder + games just played) ----
function loadHistory() {
  if (play.histLoading) return;
  play.histLoading = true;
  http.get(`/api/history?offset=0&limit=${play.histLimit || 30}`).then((h) => { play.hist = h; })
    .catch(() => { play.hist = { total: 0, games: [], error: true }; })
    .finally(() => { play.histLoading = false; renderPlayPanel(); });
}

function historyHtml() {
  const h = play.hist;
  if (!h) { loadHistory(); return `<div class="ghist"><h3>Мои партии</h3><p class="hint">Загружаю…</p></div>`; }
  const date = (t) => {
    if (!t) return "";
    const d = new Date(t);
    return d.toLocaleDateString("ru-RU", d.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  };
  const rows = h.games.map((r) => `<button type="button" class="hrow ${r.result}" data-hist="${esc(r.id)}" title="Открыть разбор этой партии">
      <span class="hres">${{ win: "+", loss: "−", draw: "½" }[r.result] || ""}</span>
      <span class="hmain"><span class="hopp">${esc(r.opp)}${r.oppRating ? ` <small>${r.oppRating}</small>` : ""}</span>
        <small class="hmeta">${esc(r.tc)} · ${r.color === "white" ? "белыми" : "чёрными"} · ${date(r.date)}${r.opening ? ` · ${esc(r.opening)}` : ""}</small></span>
      <span class="hrev">${r.review?.state === "done" ? "разобрана" : ""}</span></button>`).join("");
  return `<div class="ghist">
    <div class="hist-head"><h3>Мои партии</h3><button type="button" class="link-btn" id="hist-refresh" ${h.fetching ? "disabled" : ""}>${h.fetching ? "скачиваю новые…" : "обновить с Lichess"}</button></div>
    <p class="hint">Нажми на партию — Stockfish разберёт её на доске анализа.</p>
    <div class="hlist">${rows || `<p class="hint">${h.error ? "Не удалось загрузить список." : "Партий пока нет."}</p>`}</div>
    ${h.games.length < h.total ? `<button type="button" class="link-btn" id="hist-more">показать ещё (${h.total - h.games.length})</button>` : ""}</div>`;
}

// ---- state from the server ----
function onLive(st) {
  const prev = play.st;
  const pg = prev?.game || null, g = st.game;
  play.st = st;
  if (g) {
    if (!pg || pg.id !== g.id) { // another game
      play.ply = null;
      play.confirm = null;
      play.sent = null;
      if (g.playing) { play.show = g.id; if (prev) sound("start"); }
    } else {
      if (g.moves.length > pg.moves.length) {
        if (play.ply != null && play.ply >= pg.moves.length) play.ply = null; // was on the last move: follow the game
        if (turnNow(g) === g.color) moveSound(g.moves.at(-1).san); // the opponent just moved (our own moves sound at once)
      }
      if (pg.playing && !g.playing) { play.confirm = null; play.hist = null; } // the game joins the history list
    }
    if (play.sent && (play.sent.game !== g.id || g.moves.length > play.sent.ply || !g.playing)) play.sent = null;
  }
  applyLock();
  if (g?.playing && g.id !== pg?.id && mode !== "play") setMode("play", { save: false }); // a game started: show it, as Lichess does
  else if (mode === "play") renderPlay();
  if (mode === "play" && g?.playing && g.boardOk && play.ply == null && !play.sent && !promo && turnNow(g) === g.color) cg.playPremove();
}

// a premove onto the last rank: pick the piece now, it is played when the premove is
async function onPremoveSet(orig, dest) {
  const g = pgame();
  play.premo = null;
  const pawn = cg.state.pieces.get(orig)?.role === "pawn";
  if (!g?.playing || !pawn || dest[1] !== (g.color === "white" ? "8" : "1")) return;
  const piece = await choosePromotion(dest, g.color);
  if (!piece) { cg.cancelPremove(); playBoard(); return; }
  play.premo = { orig, dest, piece };
  playBoard(); // the opponent may have moved meanwhile
  const now = pgame();
  if (now?.playing && play.ply == null && !play.sent && turnNow(now) === now.color) cg.playPremove();
}

// a live game: only the game on screen (the server refuses the rest anyway)
function applyLock() {
  const on = isLive();
  const was = document.body.classList.contains("live");
  document.body.classList.toggle("live", on);
  if (on && !was) {
    closePreviewSilently();
    hideHover();
    $("#ctx").hidden = $("#jobs-pop").hidden = $("#chats-pop").hidden = $("#app-menu").hidden = $("#model-pop").hidden = true;
    setDrawMode(false);
    closeMenu();
    clearTimeout(askTimer);
    clearTimeout(ceval.timer);
    ceval.seq++;
  }
  $("#layout").classList.toggle("no-chat", on || !ch.open);
  if (on !== was) { renderEvalBar(); layout(); }
  reportShownChat();
}

// =====================================================================
// REPERTOIRE — the user's openings (coach/repertoire.py). «Репертуар» is «Разбор» with the repertoire on
// (rep.on; `mode` stays "study"), so the board, the tree view, the engine and the move clicks are the same.
// =====================================================================
// Two trees, «За белых» and «За чёрных», are boards with sc.rep = their colour, kept by the server apart from
// the other boards. Sections are named nodes of them (openings); a lesson is a chat bound to a section, and its
// boards are that chat's boards. The right panel shows the table of contents, or one section: its moves, its
// lessons, the tree from it and the open lesson's boards. The chat panel follows the section: its lesson.
const REP_SIDE = { white: "За белых", black: "За чёрных" };
const REP_QUICK = ["С чего начать в этом дебюте?", "Где я ошибаюсь в своих партиях здесь?", "Какие тут главные идеи и планы?"];
const repTree = (color) => study.scenes.find((s) => s.rep === color) || null;
const repSec = (id = rep.section) => (id ? rep.data.sections.find((s) => s.id === id) || null : null);
const lessonSection = (cid) => (cid ? rep.data.lessons[cid]?.section || null : null);
const lessonsOf = (sid) => ch.list.filter((c) => lessonSection(c.id) === sid);
const repQuickHtml = () => `<div class="quick">${REP_QUICK.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;

function repAgo(ts) {
  const min = Math.round((Date.now() / 1000 - ts) / 60);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  if (min < 24 * 60) return `${Math.round(min / 60)} ч назад`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
// moves of the repertoire in text as an exact line from the start: a small board on hover and the line on the
// board on a click, like moves anywhere in the app; `from` hides the moves before it, `bold` marks one, `side` is
// the colour the line is played for: the small board shows it at the bottom
function repLineHtml(ucis, { from = 0, bold = -1, side } = {}) {
  const line = playLine(START_FEN, ucis);
  if (line.plies.length <= from) return "";
  const key = regLine(line);
  return `<span class="mseq" data-nf data-line="${key}"${side ? ` data-side="${side}"` : ""}>${line.plies.map((p, i) => (i < from ? "" : `${p.num.endsWith(".") || i === from ? p.num : ""}<b class="mvl${i === bold ? " rl-hl" : ""}" data-i="${i}">${esc(p.san)}</b>`)).filter(Boolean).join(" ")}</span>`;
}
const repWay = (tree, nodeId) => (tree && tindex(tree).get(nodeId) ? pathTo(tree, nodeId).map((n) => n.uci) : []);

function repDepth(s) {
  let d = 0;
  for (let p = repSec(s.parent); p && d < 8; p = repSec(p.parent)) d++;
  return d;
}
function repScoreHtml(s) {
  if (!s.games) return `<span class="rs">партий нет</span>`;
  const cls = s.score >= 60 ? " good" : s.score < 40 ? " bad" : "";
  return `<span class="rs"><b class="sc${cls}">${s.score}%</b> · ${s.games} ${plural(s.games, "партия", "партии", "партий")}</span>`;
}
// the deepest section on the way to a node of a tree (the open section if it is on the way)
function repSectionAt(tree, id) {
  const way = new Set(pathTo(tree, id).map((n) => n.id));
  const on = rep.data.sections.filter((s) => s.color === tree.rep && way.has(s.node));
  if (on.some((s) => s.id === rep.section)) return rep.section;
  return on.sort((a, b) => pathTo(tree, b.node).length - pathTo(tree, a.node).length)[0]?.id || null;
}

// ---- the panel ----
function repPanelHtml() {
  const s = repSec();
  if (rep.game) return repGameHtml();
  if (rep.drill) return repDrillHtml();
  return s ? repSectionHtml(s) : repTocHtml();
}

// «Задачи» of a section: the user's puzzles from its games and Lichess's puzzles of its opening, solved in «Задачи»
function repPuzzleMenu(s) {
  return `<div class="menu-head">Задачи по дебюту</div>
    ${s.puzzles ? `<button type="button" class="mi" data-act="own" title="Позиции из твоих партий этого раздела, где ты ошибся или не наказал ошибку">Мои из этих партий<span class="k">${s.puzzles}</span></button>` : ""}
    <button type="button" class="mi" data-act="lichess" title="Задачи Lichess из партий в этом дебюте, в твой рейтинг на Lichess">Lichess в этом дебюте</button>`;
}

async function repOwnPuzzles(s) {
  const r = await post("/api/rep/puzzles", { section: s.id });
  pz.only = { ids: new Set(r.ids), name: s.name, section: s.id };
  lp.on = false;
  lpSave();
  setMode("puzzle");
  if (!pz.cur || !match(pz.cur) || pz.st?.result) nextPuzzle(); else renderPuzzlePanel();
}

async function repLichessPuzzles(s) {
  setStatus("Ищу задачи Lichess в этом дебюте…");
  const r = await post("/api/rep/angle", { section: s.id });
  setStatus("");
  await lpEnsure();
  lp.custom = { angle: r.angle, name: s.name, section: s.id };
  Object.assign(lp, { on: true, angle: r.angle, cur: null, st: null });
  lpSave();
  setMode("puzzle");
}

// «Сыграть» of a section: the opponent's strength (kept in this window) and the start
function repPlayMenu(s) {
  const elo = repElo();
  return `<div class="menu-head">Партия с движком</div>
    <div class="menu-note">Ты ${s.color === "white" ? "белыми" : "чёрными"}. Соперник ходит по твоему дереву, дальше — Stockfish.</div>
    <div class="menu-head">Соперник примерно</div>
    <div class="seg">${REP_ELO.map((e) => `<button type="button" data-act="elo:${e}" class="${e === elo ? "on" : ""}" aria-pressed="${e === elo}">${e}</button>`).join("")}</div>
    <div class="menu-pad"><button type="button" class="btn primary full" data-act="start">Начать партию</button></div>`;
}

// «Повторить по памяти»: what is due — the one primary button of the screen; when nothing is due, a run over
// everything, as a plain button; nothing to drill (no moves of the user's yet) — no button
function repDrillButton(scope, id) {
  const cards = drillCardsIn(scope);
  if (!cards) return "";
  const due = drillDueIn(scope);
  const title = due ? `${due} из ${cards} ${plural(cards, "позиции", "позиций", "позиций")} пора повторить` : `всё повторено, ${cards} ${plural(cards, "позиция", "позиции", "позиций")}`;
  return `<button type="button" class="btn big${due ? " primary" : ""}" id="${id}" data-practice="${due ? "" : "1"}" title="${title}">${due ? `Повторить по памяти · ${due}` : "Повторить всё по памяти"}</button>`;
}

const sideOf = () => scene()?.rep || rep.color || "white";

function repTocHtml() {
  const color = sideOf();
  const row = (s) => {
    const due = drillDueIn({ section: s.id });
    return `<button type="button" class="rep-row${s.status === "retired" ? " retired" : ""}" data-sec="${esc(s.id)}" style="--d:${repDepth(s)}">
      <span class="rn">${esc(s.name)}</span>${due ? `<span class="badge" title="Позиций пора повторить">${due}</span>` : "<span></span>"}${repScoreHtml(s)}</button>`;
  };
  const list = rep.data.sections.filter((s) => s.color === color && s.status !== "retired");
  const retired = rep.data.sections.filter((s) => s.color === color && s.status === "retired");
  const seg = `<div class="seg wide" role="tablist" aria-label="Сторона">${["white", "black"].map((c) => {
    const due = drillDueIn({ color: c });
    return `<button type="button" role="tab" data-rep-color="${c}" class="${c === color ? "on" : ""}" aria-selected="${c === color}">${REP_SIDE[c]}${due ? `<span class="badge">${due}</span>` : ""}</button>`;
  }).join("")}</div>`;
  const sc = scene();
  const way = sc?.rep && study.node !== "root" ? pathTo(sc, study.node) : [];
  const here = !repTrial() && way.length ? `<div class="rep-board"><span class="rep-path">${way.map((n, i) => inlineMove(n, study.node, i === 0)).join("")}</span>
      <button type="button" class="btn small" id="rep-here">Сделать разделом</button></div>` : "";
  return `<div class="p-head"><div class="p-title"><h1 class="title">Мой репертуар ${helpBtn("toc")}</h1></div>${dotsBtn("rep-toc-menu", "Новый дебют, обновить из партий")}</div>
    ${helpText("toc", `Дебюты, которые ты играешь, по разделам. Процент — сколько очков ты набрал в партиях раздела, рядом — сколько было партий; синее число — сколько позиций пора повторить по памяти.
      Сделай ходы на доске — получится пробный вариант: его можно записать в репертуар или сделать разделом.`)}
    ${repDrillButton({}, "drill-all")}
    ${seg}
    ${rep.form ? repFormHtml() : ""}
    <div class="rep-list">${list.map(row).join("") || `<p class="hint">Разделов пока нет.</p>`}</div>
    ${retired.length ? `<details class="rep-group"><summary>Не играю · ${retired.length}</summary>${retired.map(row).join("")}</details>` : ""}
    ${cevalHtml()}${here}${repTrialHtml(true)}`;
}

function repFormHtml() {
  return `<form class="rep-form" id="rep-form">
      <div class="rep-seg"><label><input type="radio" name="rep-color" value="white"${sideOf() === "white" ? " checked" : ""}> за белых</label>
        <label><input type="radio" name="rep-color" value="black"${sideOf() === "black" ? " checked" : ""}> за чёрных</label></div>
      <input id="rep-moves" placeholder="Ходы от начала: 1.e4 c6" autocomplete="off">
      <input id="rep-name" placeholder="Название — можно не писать, возьмётся по ходам" autocomplete="off">
      <div class="actions"><button class="btn primary" type="submit">Добавить</button><button class="btn quiet" type="button" id="rep-form-cancel">Отмена</button></div></form>`;
}

// labels on the section's tree: the sections inside it, and where the user's games went past the preparation
function repTreeTags(s) {
  const tags = new Map();
  const add = (id, html) => tags.set(id, (tags.get(id) || "") + html);
  for (const x of rep.data.sections) {
    if (x.color !== s.color || x.id === s.id || x.status === "retired") continue;
    const cls = x.score >= 60 ? " good" : x.score < 40 ? " bad" : "";
    add(x.node, `<button type="button" class="seclabel" data-sec="${esc(x.id)}" title="Открыть раздел «${esc(x.name)}»">${esc(x.name)}${x.games ? ` · <b class="sc${cls}">${x.score}%</b>` : ""}</button>`);
  }
  const d = rep.games?.section === s.id ? rep.games.data : null;
  for (const x of d?.end || []) {
    add(x.node, `<button type="button" class="hole" data-rep-tab="games" title="Здесь кончается твоя подготовка: ${rgGames(x.games)} шли дальше без дерева">нет подготовки · ${x.games}</button>`);
  }
  for (const x of d?.opponent || []) {
    add(x.node, `<button type="button" class="hole" data-rep-tab="games" title="Соперники играли здесь ${esc(x.num + x.played)}, а в дереве ответа нет">соперник: ${esc(x.num + x.played)} · ${x.games}</button>`);
  }
  return tags;
}

function repSectionHtml(s) {
  const tree = repTree(s.color);
  const sc = scene();
  const onTree = !!sc?.rep;
  const node = tree ? tindex(tree).get(s.node)?.n : null;
  const parent = repSec(s.parent);
  const lessons = lessonsOf(s.id);
  const inLesson = lessonSection(ch.cur) === s.id;
  if (rep.games?.section !== s.id) repLoadGames(s.id); // the labels on the tree and the «Партии» tab
  const games = rep.games?.data;
  const way = onTree && node ? pathTo(tree, node.id).map((n, i) => inlineMove(n, study.node, i === 0)).join("") : repLineHtml(repWay(tree, s.node), { side: s.color }) || esc(s.path);
  const crumbs = `<div class="rep-crumbs"><button type="button" class="link-btn" data-rep-toc>‹ Мой репертуар</button><span>·</span>
      <span>${REP_SIDE[s.color]}${parent ? ` › <button type="button" class="link-btn" data-sec="${esc(parent.id)}">${esc(parent.name)}</button>` : ""}</span></div>`;
  const title = rep.rename
    ? `<form id="rep-rename" class="newpos"><input id="rep-rename-input" value="${esc(s.name)}" autocomplete="off"><button class="btn small primary" type="submit">Сохранить</button></form>`
    : `<h1 class="title">${esc(s.name)}${s.status === "retired" ? ` <span class="rtag">не играю</span>` : ""}</h1>`;
  const head = `<div class="p-head"><div class="p-title">${crumbs}${title}<div class="rep-meta"><span class="rep-path">${way}</span>${repScoreHtml(s)}</div></div>
    ${dotsBtn("rep-sec-menu", "Переименовать, конспект, не играю, удалить")}</div>`;
  const acts = `<div class="acts">
      <button type="button" class="act" id="rep-lesson-go">${ICON.spark}<span>Урок с Claude</span><small>${lessons.length ? `${lessons.length} ${plural(lessons.length, "урок", "урока", "уроков")}` : "начать первый"}</small></button>
      <button type="button" class="act" id="rep-play-menu">${ICON.play}<span>Сыграть</span><small>соперник ≈${repElo()}</small></button>
      <button type="button" class="act" id="rep-puz-menu">${ICON.target}<span>Задачи</span><small>${s.puzzles ? `${s.puzzles} из партий` : "Lichess"}</small></button></div>`;
  const tab = rep.tab || "tree";
  const nGames = games?.games ?? s.games ?? 0;
  const tabs = `<div class="tabs" role="tablist">${[["tree", "Дерево", ""], ["games", "Партии", nGames || ""], ["lessons", "Уроки", lessons.length || ""]]
    .map(([k, l, n]) => `<button type="button" class="tab${tab === k ? " on" : ""}" role="tab" aria-selected="${tab === k}" data-rep-tab="${k}">${l}${n !== "" ? ` <span class="n">${n}</span>` : ""}</button>`).join("")}
    <span class="grow"></span>${tab === "tree" ? helpBtn("tree") : tab === "games" ? helpBtn("games") : ""}</div>`;
  let body;
  if (tab === "games") body = repGamesHtml(s);
  else if (tab === "lessons") body = repLessonsHtml(s, lessons);
  else {
    const help = helpText("tree", `Дерево — ходы, которые ты решил играть. Ход на доске сначала пробный: в дерево он попадёт кнопкой «Записать в репертуар».
      Меню хода — правый клик, долгое нажатие или ⋯ на текущем ходе: сделать главным, сделать разделом, удалить.
      <span class="user">Жёлтые</span> ходы сделаны тобой на доске, белые — записаны Claude или взяты из твоих партий.
      Метки на ходах — разделы внутри этого и места, где твои партии ушли дальше подготовки.`);
    let main = "";
    if (onTree && node) {
      const tags = repTreeTags(s);
      const rootTags = tags.get(node.id) || "";
      main = `${cevalHtml()}${node.comment ? `<div class="rich lead">${md(node.comment)}</div>` : ""}
        ${repTrialHtml(false)}${rootTags ? `<div class="tags">${rootTags}</div>` : ""}
        ${boardTreeHtml(node, undefined, tags) || `<p class="hint">Ходов пока нет. Сыграй ход на доске или начни урок с Claude.</p>`}`;
    } else if (sc) {
      main = `<h2 class="rep-sub">${esc(sc.title)}</h2>${cevalHtml()}${sc.root.comment ? `<div class="rich lead">${md(sc.root.comment)}</div>` : ""}
        ${boardTreeHtml(sc.root) || `<p class="hint">Ходов пока нет.</p>`}`;
    }
    body = help + main;
  }
  return head + repDrillButton({ section: s.id }, "drill-sec") + acts + tabs + body;
}

// «Уроки» of a section: its chats with Claude, newest first; × deletes one (asks again), its boards stay in «Разбор»
function repLessonsHtml(s, lessons) {
  const rows = lessons.map((c, i) => `<div class="lesson-row${c.id === ch.cur ? " on" : ""}">
      <button type="button" class="lesson-open" data-lesson="${esc(c.id)}" title="${esc(c.title)}">${c.busy ? '<span class="dot"></span>' : ""}<span class="ln-title">${esc(c.title === "Новый чат" ? `Урок ${lessons.length - i}` : c.title)}</span><span class="ln-date">${c.updated ? repAgo(c.updated) : ""}</span></button>
      <button type="button" class="lesson-del${rep.delLesson === c.id ? " confirm" : ""}" data-lesson-del="${esc(c.id)}" title="Удалить урок" aria-label="Удалить урок">${rep.delLesson === c.id ? "Удалить?" : "×"}</button></div>`).join("");
  return `<div class="lesson-list">${rows || `<p class="hint">Уроков пока нет.</p>`}</div>
    <div class="row"><button type="button" class="btn" id="rep-lesson-new">＋ Новый урок</button></div>
    <p class="hint">${s.notes_at ? `Claude ведёт конспект раздела, обновлён ${repAgo(s.notes_at)}.` : "Конспект раздела Claude начнёт на первом уроке."}
      ${s.notes_at ? `<button type="button" class="link-btn" id="rep-notes">Показать конспект</button>` : ""}</p>`;
}

function repChatEmptyHtml() {
  const s = repSec();
  if (!s) {
    return `<div class="chat-empty"><h3>Чат с Claude</h3><p>Выбери раздел репертуара, чтобы начать урок по нему, или спроси о дебютах вообще — например, что тебе стоит играть.</p></div>`;
  }
  return `<div class="chat-empty"><h3>Урок: ${esc(s.name)}</h3><p>Claude знает этот раздел, твои партии в нём и что прошли на прошлых уроках. Напиши, что хочешь разобрать, или начни с вопроса.</p>${repQuickHtml()}</div>`;
}

// ---- trying moves: on a repertoire tree a move that is not in it is only tried — a trial line from the node on
// screen. It goes into the repertoire with «Записать в репертуар» (or becomes a section): the tree keeps only moves
// the user decided on, and the first of the user's moves in a position is the one the training will ask for. ----
function repTrial() { // the trial line on screen {base, start, plies}, or null (one left behind is dropped)
  const t = rep.trial;
  if (!t) return null;
  const sc = scene();
  const base = sc?.id === t.scene ? tindex(sc).get(t.base)?.n : null;
  if (!rep.on || mode !== "study" || !base || study.node !== t.base || !t.ucis.length) { rep.trial = null; return null; }
  return { base, ...playLine(base.fen, t.ucis) };
}

function repTrialBoard() {
  const tr = rep.on ? repTrial() : null;
  if (!tr) return false;
  const last = tr.plies.at(-1);
  setBoard({ fen: last.fen, orientation: boardOrientation(), lastMove: sq(last.uci), shapes: engineArrow(last.fen),
    movable: { color: turnOf(last.fen), dests: legalDests(last.fen), after: onStudyMove } });
  return true;
}

function repTry(uci) { // true: the move went into the trial line
  if (!repTrial()) {
    if (curNode()?.children.some((c) => c.uci === uci)) return false; // a move of the tree: just go there
    rep.trial = { scene: study.id, base: study.node, ucis: [] };
  }
  rep.trial.ucis.push(uci);
  renderStudy();
  return true;
}

function repTrialStep(dir) {
  if (!repTrial()) return false;
  if (dir === "prev") rep.trial.ucis.pop();
  else if (dir === "first") rep.trial = null;
  else return true; // nothing ahead of a trial line
  renderStudy();
  return true;
}

function repTrialHtml(toc) {
  const tr = repTrial();
  if (!tr) return "";
  const way = repWay(scene(), tr.base.id);
  const moves = repLineHtml([...way, ...tr.plies.map((p) => p.uci)], { from: way.length, side: scene()?.rep });
  return `<div class="rep-trial"><div class="rep-trial-head">Пробный вариант — ещё не в репертуаре</div><div class="rep-path">${moves}</div>
    <div class="actions">${toc ? `<button type="button" class="btn primary" id="rep-trial-section">Сделать разделом</button>` : ""}
      <button type="button" class="btn${toc ? "" : " primary"}" id="rep-trial-save">Записать в репертуар</button>
      <button type="button" class="btn quiet" id="rep-trial-drop">Убрать</button></div></div>`;
}

async function repTrialSave(asSection) {
  const tr = repTrial();
  const sc = scene();
  if (!tr || !sc?.rep) return;
  const ucis = tr.plies.map((p) => p.uci);
  if (asSection) {
    rep.trial = null;
    await repNewSection(sc.rep, [...pathTo(sc, tr.base.id).map((n) => n.uci), ...ucis]);
    return;
  }
  const second = turnOf(tr.base.fen) === sc.rep && tr.base.children.length > 0; // the user's side already has a move here
  const r = await post("/api/scene/add", { scene: sc.id, at: tr.base.id, moves: ucis, goto: "end" });
  rep.trial = null;
  study.node = r.last.node;
  renderStudy();
  if (second) {
    setStatus(`Здесь у тебя теперь ${tr.base.children.length + 1} хода; тренировка спросит первый. Сменить — правый клик по ходу → «Сделать главной линией».`);
    setTimeout(() => setStatus(""), 6000);
  }
}

// ---- the drill: the app plays the opponent's moves of a tree, the user plays their own from memory (coach/repertoire.py).
// A card is a position where it is the user's move (key: colour + position, so another move order reaches the same card);
// its answer is the main move there — or, on the way to a drilled section, that way's move. Due cards come first, a missed
// one comes back in the same session, and every first answer is spaced on the server like the puzzles. ----
const drillKey = (color, node) => `${color}:${fenKey(node.fen)}`;
function drillDue(key) {
  const d = rep.drill;
  if (d?.again.has(key)) return true;
  if (d?.done.has(key)) return false;
  if (d?.practice) return true;
  const c = rep.data.drill?.[key];
  return !c || c.due <= Date.now();
}
const drillAnswer = (node, way) => way?.get(node.id) || node.children[0] || null;

// cards from `node` on that `pred` accepts: along the answer on the user's turn, every reply on the opponent's
// (only the way's move on the way to a section); `skip` = retired sections
function drillWalk(color, node, skip, way, pred) {
  if (!node || skip.has(node.id) || !node.children.length) return 0;
  if (turnOf(node.fen) === color) return (pred(drillKey(color, node)) ? 1 : 0) + drillWalk(color, drillAnswer(node, way), skip, way, pred);
  const w = way?.get(node.id);
  return w ? drillWalk(color, w, skip, way, pred) : node.children.reduce((n, c) => n + drillWalk(color, c, skip, way, pred), 0);
}

// where a drill goes: one section (from the start of its tree, by the way to it) or the whole repertoire
function drillRoots(scope) {
  const retired = rep.data.sections.filter((s) => s.status === "retired");
  const s = scope.section ? repSec(scope.section) : null;
  if (s) {
    const tree = repTree(s.color);
    if (!tree || !tindex(tree).get(s.node)) return [];
    const way = new Map();
    let prev = tree.root;
    for (const n of pathTo(tree, s.node)) { way.set(prev.id, n); prev = n; }
    const onWay = new Set([tree.root.id, ...way.values()].map((n) => (typeof n === "string" ? n : n.id)));
    const skip = new Set(retired.filter((r) => r.color === s.color && r.id !== s.id && !onWay.has(r.node)).map((r) => r.node));
    return [{ color: s.color, tree, start: tree.root, way, skip }];
  }
  return ["white", "black"].filter((c) => !scope.color || c === scope.color).map((c) => repTree(c)).filter(Boolean)
    .map((tree) => ({ color: tree.rep, tree, start: tree.root, way: null, skip: new Set(retired.filter((r) => r.color === tree.rep).map((r) => r.node)) }));
}
const drillCount = (scope, pred) => drillRoots(scope).reduce((n, r) => n + drillWalk(r.color, r.start, r.skip, r.way, pred), 0);
const drillDueIn = (scope) => drillCount(scope, drillDue);
const drillCardsIn = (scope) => drillCount(scope, () => true);
function drillNextDue(scope) { // the earliest time a card of the scope comes due, ms
  let at = Infinity;
  drillCount(scope, (k) => { const c = rep.data.drill?.[k]; if (c && c.due > Date.now()) at = Math.min(at, c.due); return false; });
  return at < Infinity ? at : null;
}
function repIn(ms) {
  const min = Math.max(1, Math.round((ms - Date.now()) / 60000));
  if (min < 60) return `через ${min} мин`;
  if (min < 20 * 60) return `через ${Math.round(min / 60)} ч`;
  const days = Math.round(min / 1440);
  return days <= 1 ? "завтра" : `через ${days} ${plural(days, "день", "дня", "дней")}`;
}
function pickWeighted(list, w) {
  let k = Math.random() * list.reduce((n, x) => n + w(x), 0);
  for (const x of list) { k -= w(x); if (k < 0) return x; }
  return list.at(-1);
}
const drillTree = () => study.scenes.find((s) => s.id === rep.drill?.line?.tree) || null;
function drillNode() { const t = drillTree(); return t ? tindex(t).get(rep.drill.line.cur)?.n || null : null; }

function drillStart(scope, practice = false) {
  repDrillStop(false);
  repGameStop(false);
  rep.trial = null;
  closePreviewSilently();
  rep.drill = { scope, practice, again: new Set(), done: new Set(), ok: 0, fail: 0, line: null, over: false, timer: null };
  drillNextLine();
}

function repDrillStop(render = true) {
  const d = rep.drill;
  if (!d) return;
  clearTimeout(d.timer);
  rep.drill = null;
  if (!render || !rep.on || mode !== "study") return;
  const s = repSec();
  study.id = repTree(s?.color || rep.color)?.id ?? null;
  study.node = s ? s.node : "root";
  renderStudy();
  updateCounts();
}

function drillNextLine() {
  const d = rep.drill;
  if (!d) return;
  const roots = drillRoots(d.scope).map((r) => ({ ...r, due: drillWalk(r.color, r.start, r.skip, r.way, drillDue) })).filter((r) => r.due > 0);
  if (!roots.length) { d.line = null; d.over = true; renderStudy(); return; }
  const r = pickWeighted(roots, (x) => x.due);
  d.line = { color: r.color, tree: r.tree.id, cur: r.start.id, skip: r.skip, way: r.way, ask: null, wrong: false, hinted: false, alt: "", end: false };
  study.id = r.tree.id;
  drillStep();
}

// the line goes on from its node: a due position of the user waits for their move; the opponent's replies and the
// user's moves they already know (not due, or answered right earlier in this session) are played by the app
function drillStep() {
  const d = rep.drill;
  const L = d?.line;
  if (!L) return;
  const node = drillNode();
  if (!node) { drillNextLine(); return; }
  study.node = node.id;
  Object.assign(L, { ask: null, wrong: false, hinted: false, alt: "" });
  const due = (n) => drillWalk(L.color, n, L.skip, L.way, drillDue);
  if (!due(node)) { // nothing due further on: this line is done
    L.end = true;
    renderStudy();
    d.timer = setTimeout(() => { if (rep.drill === d) drillNextLine(); }, 1100);
    return;
  }
  let next;
  if (turnOf(node.fen) === L.color) { // the user's move: asked when due, else played for them like a known move
    if (drillDue(drillKey(L.color, node))) { L.ask = node.id; renderStudy(); return; }
    next = drillAnswer(node, L.way);
  } else next = L.way?.get(node.id) || pickWeighted(node.children.filter((c) => due(c) > 0), due);
  renderStudy();
  d.timer = setTimeout(() => {
    if (rep.drill !== d) return;
    L.cur = next.id;
    moveSound(next.san);
    drillStep();
  }, node.id === "root" ? 300 : 600);
}

function repDrillMove(uci) { // true: the drill took the move
  const d = rep.on ? rep.drill : null;
  if (!d) return false;
  const L = d.line;
  const node = drillNode();
  if (!L?.ask || !node || node.id !== L.ask) { renderStudy(); return true; }
  const want = drillAnswer(node, L.way);
  const key = drillKey(L.color, node);
  if (uci === want.uci) {
    const first = !L.wrong && !L.hinted;
    if (first && d.again.has(key)) d.again.delete(key); // a card missed earlier in this session, now right
    else if (first && drillDue(key)) drillRecord(key, true);
    if (first) d.ok++;
    d.done.add(key);
    moveSound(want.san);
    L.cur = want.id;
    drillStep();
    return true;
  }
  const alt = node.children.find((c) => c.uci === uci);
  if (alt && alt !== want) { L.alt = alt.san; renderStudy(); return true; } // the user's other move here: not a mistake
  if (!L.wrong && !L.hinted) drillMiss(key);
  L.wrong = true;
  renderStudy();
  return true;
}

function drillMiss(key) {
  const d = rep.drill;
  d.fail++;
  d.again.add(key);
  drillRecord(key, false);
}

async function drillRecord(key, ok) {
  try {
    rep.data.drill[key] = await post("/api/rep/drill", { key, ok });
    updateCounts();
  } catch (err) { setStatus(String(err.message), true); }
}

function drillHint() {
  const L = rep.drill?.line;
  if (!L?.ask || L.hinted || L.wrong) return;
  L.hinted = true;
  drillMiss(drillKey(L.color, drillNode()));
  renderStudy();
}

function repDrillBoard() {
  const d = rep.on ? rep.drill : null;
  if (!d) return false;
  const node = drillNode();
  if (!node) { setBoard({ fen: shownFen, orientation: boardOrientation() }); return true; }
  const L = d.line;
  const want = L.ask && (L.wrong || L.hinted) ? drillAnswer(node, L.way) : null;
  setBoard({
    fen: node.fen, orientation: boardOrientation(), lastMove: node.uci ? sq(node.uci) : undefined,
    shapes: want ? [{ orig: want.uci.slice(0, 2), dest: want.uci.slice(2, 4), brush: "green" }] : [],
    movable: L.ask ? { color: L.color, dests: legalDests(node.fen), after: onStudyMove } : null,
  });
  return true;
}

function repDrillHtml() {
  const d = rep.drill;
  const s = d.scope.section ? repSec(d.scope.section) : null;
  const left = d.over ? 0 : drillDueIn(d.scope);
  const done = d.ok + d.fail;
  const head = `<div class="p-head"><div class="p-title"><div class="rep-crumbs"><button type="button" class="link-btn" id="drill-stop">‹ Закончить</button></div>
      <h1 class="title">Повторение · ${esc(s ? s.name : "весь репертуар")} ${helpBtn("drill")}</h1></div></div>
    ${helpText("drill", "Программа ходит за соперника по дереву репертуара, а ты по памяти отвечаешь там, где пора повторить; ходы, которые ты уже помнишь, она делает сама. Верный ответ вернёт позицию через день, потом всё реже; ошибка — через 10 минут и ещё раз в этой тренировке.")}
    <div class="prog" role="progressbar" aria-valuenow="${done}" aria-valuemax="${done + left}"><i style="width:${done + left ? Math.round((100 * done) / (done + left)) : 100}%"></i></div>
    <div class="drill-stats"><span>верно <b>${d.ok}</b></span><span>ошибок <b>${d.fail}</b></span><span>осталось <b>${left}</b></span>${d.practice ? `<span class="rtag">повтор всего</span>` : ""}</div>`;
  if (d.over) {
    const cards = drillCardsIn(d.scope);
    const next = drillNextDue(d.scope);
    const text = !cards ? "Здесь пока нечего тренировать: в дереве нет твоих ходов. Добавь их на уроке с Claude или кнопкой «Записать в репертуар»."
      : `${d.ok + d.fail ? `Готово: верно ${d.ok}, ошибок ${d.fail}.` : "Сейчас повторять нечего."}${next ? ` Следующее повторение — ${repIn(next)}.` : ""}`;
    return `${head}<div class="drill-box ok">${text}</div>
      <div class="rep-actions"><button type="button" class="btn primary" id="drill-stop2">${s ? "К разделу" : "К оглавлению"}</button>
        ${cards ? `<button type="button" class="btn" id="drill-again">Повторить всё ещё раз</button>` : ""}</div>`;
  }
  const L = d.line;
  const tree = drillTree();
  const node = drillNode();
  const way = tree && node ? pathTo(tree, node.id) : [];
  const line = way.map((n, i) => `${n.num.endsWith(".") || i === 0 ? `<span class="num">${esc(n.num)}</span>` : ""}${esc(n.san)}`).join(" ");
  let box;
  if (L.end) box = `<div class="drill-box ok">Вариант пройден ✓</div>`;
  else if (!L.ask) box = `<div class="drill-box">Соперник ходит…</div>`;
  else if (L.wrong || L.hinted) {
    const want = drillAnswer(node, L.way);
    box = `<div class="drill-box bad"><div>${L.hinted ? "Подсказка" : "Не так"}: в репертуаре здесь <b>${esc(want.num.endsWith(".") ? want.num : want.num.replace("…", "..."))}${esc(want.san)}</b> — сыграй его. Эту позицию спрошу ещё раз.</div>
      ${want.comment ? `<div class="rich">${md(want.comment)}</div>` : ""}
      <div class="actions"><button type="button" class="btn" id="drill-why">${ICON.spark}Почему так?</button></div></div>`;
  } else {
    box = `<div class="drill-box"><div>${L.alt ? `${esc(L.alt)} — твой запасной ход. А какой здесь главный?` : `Твой ход за ${L.color === "white" ? "белых" : "чёрных"}. Что ты здесь играешь?`}</div>
      <div class="actions"><button type="button" class="btn" id="drill-hint">Подсказка</button></div></div>`;
  }
  return `${head}${box}<div class="rep-path drill-line">${line || "начальная позиция"}</div>`;
}

// ---- the user's games against the tree (coach/repertoire.py check_game): where they or the opponent left it ----
// rep.games: the open section's report {section, data | loading | error}, fetched when the section shows and again
// after the tree or the games change; rep.after: the check of finished live games, by game id.
const RG_RESULT = { win: "победа", loss: "поражение", draw: "ничья" };
const rgGames = (k) => `${k} ${plural(k, "партия", "партии", "партий")}`;

function repLoadGames(sid) {
  if (rep.games?.section === sid) return;
  rep.games = { section: sid, loading: true };
  post("/api/rep/games", { section: sid })
    .then((data) => { if (rep.games?.section !== sid) return; rep.games = { section: sid, data }; if (rep.on && mode === "study" && !rep.drill) renderStudyPanel(); })
    .catch((err) => { if (rep.games?.section === sid) rep.games = { section: sid, error: String(err.message) }; });
}

function rgCheckText(k) {
  if (k.kind === "user") return k.learned ? `ты ушёл: ${k.num}${k.played}` : `играл иначе, ещё до записи хода: ${k.num}${k.played}`;
  if (k.kind === "opponent") return `соперник ушёл: ${k.num}${k.played}`;
  return k.kind === "end" ? "по дереву до конца подготовки" : "вся партия по дереву";
}

function repGamesHtml(s) {
  if (rep.games?.section !== s.id) repLoadGames(s.id);
  const d = rep.games?.data;
  if (!d) return rep.games?.error ? `<p class="hint">Партии не сверились: ${esc(rep.games.error)}</p>` : `<p class="hint">Сверяю твои партии с деревом…</p>`;
  if (!d.games) return `<p class="hint">Партий в этом дебюте пока нет.</p>`;
  const c = d.counts || {};
  const tree = repTree(s.color);
  const row = (x, kind, i) => {
    const way = repWay(tree, x.node);
    const move = kind === "end" ? `после ${repLineHtml(way, { side: s.color }) || esc(x.before)}` : repLineHtml([...way, x.uci], { bold: way.length, side: s.color });
    const want = tree && tindex(tree).get(x.node)?.n.children.find((c) => c.san === x.expected?.[0]);
    const exp = (kind === "user" || kind === "habit") && want ? ` <span class="rg-exp">вместо ${repLineHtml([...way, want.uci], { from: way.length, side: s.color })}</span>` : "";
    return `<div class="rg-row ${kind}"><span class="rep-path">${move}${exp}</span><span class="rg-n">${rgGames(x.games)}</span>
      <span class="rg-act"><button type="button" class="btn small" data-rg-goto="${esc(x.node)}">Показать</button>${kind === "opponent"
        ? `<button type="button" class="btn small" data-rg-add="${i}">В дерево</button>` : ""}<button type="button" class="btn small quiet" data-rg-ask="${kind}" data-i="${i}">${ICON.spark}Спросить</button></span></div>`;
  };
  const group = (kind, title) => (d[kind]?.length ? `<h3>${title}</h3>${d[kind].map((x, i) => row(x, kind, i)).join("")}` : "");
  const recent = d.recent.map((g, i) => `<button type="button" class="rg-game" data-rg-game="${i}" title="Показать партию на доске">
      <span>${new Date(g.date).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} · ${esc(g.opp)}${g.oppRating ? ` (${g.oppRating})` : ""}</span>
      <span class="res ${g.outcome}">${RG_RESULT[g.outcome] || ""}</span><span class="rg-chk ${g.check.kind === "user" && !g.check.learned ? "habit" : g.check.kind}">${esc(rgCheckText(g.check))}</span></button>`).join("");
  return `${helpText("games", `Партия идёт по дереву, пока кто-то не сыграет ход, которого в нём нет. Твой такой ход считается ошибкой, только если партия сыграна после того, как ход записан в дерево; более ранние партии — «раньше играл иначе». Ход соперника — ответ, который стоит подготовить.
      <span class="rg-legend"><span class="k tree">Синие</span> — ходы из твоего дерева; подчёркнут ход не по дереву: <span class="k user">красный</span> — ты ушёл, уже зная ход, <span class="k habit">серый</span> — раньше играл иначе, <span class="k opp">жёлтый</span> — ход соперника, которого в дереве нет.</span>`)}
    <div class="rep-games"><div class="rg-sum">${rgGames(d.games)} · ты уходил из дерева ${c.user || 0} · соперник ${c.opponent || 0}</div>
    ${group("user", "Где ты уходишь из дерева")}${group("habit", "Раньше играл иначе — до того, как ход появился в дереве")}${group("opponent", "Ходы соперников, на которые в дереве нет ответа")}${group("end", "Где кончается подготовка")}
    <h3>Последние партии</h3><div class="rg-games">${recent}</div></div>`;
}

// a finished live game said against the repertoire (asked after the game, never during it)
function repAfterGameHtml(g) {
  try { return repAfterGame(g); } catch { return ""; } // never in the way of the game's result
}
function repAfterGame(g) {
  if (!g || g.playing || !g.color || g.moves.length < 2 || g.startFen !== START_FEN || !repTree(g.color)) return "";
  const a = rep.after[g.id];
  if (!a) {
    rep.after[g.id] = { loading: true };
    post("/api/rep/check", { color: g.color, moves: g.moves.map((m) => m.uci) })
      .then((r) => { rep.after[g.id] = r; if (mode === "play") renderPlayPanel(); })
      .catch(() => { rep.after[g.id] = { error: true }; });
    return "";
  }
  if (!a.kind) return "";
  const ucis = g.moves.map((m) => m.uci);
  const at = a.ply ? a.ply - 1 : ucis.length; // the move that left the tree
  const where = at ? `после ${repLineHtml(ucis.slice(0, at), { side: g.color })}` : "в начальной позиции";
  const played = a.ply ? repLineHtml(ucis.slice(0, a.ply), { from: at, side: g.color }) : "";
  const want = repTree(g.color) && tindex(repTree(g.color)).get(a.node)?.n.children.find((c) => c.san === a.expected?.[0]);
  const text = a.kind === "user" ? `${where} ты сыграл ${played}, а в твоём репертуаре ${want ? repLineHtml([...ucis.slice(0, at), want.uci], { from: at, side: g.color }) : esc(a.expected[0])}`
    : a.kind === "opponent" ? `${where} соперник сыграл ${played} — на этот ход в репертуаре ответа нет`
      : a.kind === "end" ? `партия шла по репертуару до конца подготовки — ${where}` : "вся партия прошла по репертуару";
  return `<div class="rep-after ${a.kind}"><b>Репертуар${a.section_name ? ` · ${esc(a.section_name)}` : ""}:</b> ${text}.
    <button type="button" class="link-btn" id="rep-after-show" data-color="${g.color}" data-node="${esc(a.node)}" data-section="${esc(a.section || "")}">показать в репертуаре</button></div>`;
}

$("#panel").addEventListener("click", (e) => {
  const t = e.target.closest("#rep-after-show");
  if (!t || mode !== "play" || isLive()) return;
  rep.section = t.dataset.section || null;
  repRemember();
  rep.games = null;
  study.id = repTree(t.dataset.color)?.id ?? null;
  study.node = t.dataset.node;
  setMode("rep");
});

async function repGamesClick(t) {
  const s = repSec();
  const d = rep.games?.data;
  const tree = s && repTree(s.color);
  if (!s || !d || !tree) return;
  const show = (node) => { closePreviewSilently(); study.id = tree.id; study.node = node; renderStudy(); };
  if (t.dataset.rgGoto) show(t.dataset.rgGoto);
  else if (t.dataset.rgAdd) {
    const x = d.opponent[Number(t.dataset.rgAdd)];
    const r = await post("/api/scene/add", { scene: tree.id, at: x.node, moves: [x.uci], goto: "end" });
    show(r.last.node);
    setStatus("Ход соперника записан. Сыграй на доске свой ответ и нажми «Записать в репертуар» — или спроси Claude.");
    setTimeout(() => setStatus(""), 7000);
  } else if (t.dataset.rgAsk) {
    const x = d[t.dataset.rgAsk][Number(t.dataset.i)];
    const where = x.before ? `после ${x.before}` : "в начальной позиции";
    const text = t.dataset.rgAsk === "user"
      ? `В ${x.games} ${plural(x.games, "партии", "партиях", "партиях")} ${where} я уже после записи хода в репертуар сыграл ${x.num}${x.played} вместо ${x.expected[0]}. Помоги запомнить: чем ${x.expected[0]} лучше и чем плох мой ход.`
      : t.dataset.rgAsk === "habit"
        ? `Раньше ${where} я играл ${x.num}${x.played} (${rgGames(x.games)}), а теперь в моём репертуаре ${x.expected[0]}. Чем ${x.expected[0]} лучше моей старой привычки?`
      : t.dataset.rgAsk === "opponent"
        ? `В моих партиях соперники ${where} играют ${x.num}${x.played} (${rgGames(x.games)}), а в репертуаре ответа на это нет. Что мне здесь играть?`
        : `Моя подготовка кончается ${where} (${rgGames(x.games)}). Как играть дальше в этой позиции?`;
    show(x.node);
    setChatOpen(true);
    askClaude(text);
  } else if (t.dataset.rgGame) {
    const g = d.recent[Number(t.dataset.rgGame)];
    const line = playLine(START_FEN, g.ucis);
    openPreview(line, Math.max(0, Math.min((g.check.ply || line.plies.length) - 1, line.plies.length - 1)), `Партия с ${g.opp}`);
  }
}

// ---- a training game against the engine: the opponent plays the repertoire tree — the way to the section, then the
// replies that need practice most (due in the drill), or the line Claude chose (repertoire_play) — and Stockfish at the
// chosen strength once the tree runs out (/api/rep/engine). Leaving the tree is noted, never blocked; no engine hints
// during the game; at the end the game goes onto a board of the section's lesson for Claude to review. ----
const REP_ELO = [1350, 1500, 1700, 1900, 2200];
function repElo() { try { return Number(localStorage.getItem("rep.elo")) || 1500; } catch { return 1500; } }
const gameTree = () => study.scenes.find((x) => x.id === rep.game?.tree) || null;
const gameFen = () => rep.game.fens.at(-1);
function gameTreeAt(tree, fen) { // the node of a tree with this position (another move order too)
  const k = fenKey(fen);
  for (const { n } of tindex(tree).values()) if (fenKey(n.fen) === k) return n;
  return null;
}

function gameStart(sid, plan = null) {
  const s = repSec(sid);
  const tree = s && repTree(s.color);
  if (!tree) return;
  repDrillStop(false);
  rep.trial = null;
  closePreviewSilently();
  if (rep.game) clearTimeout(rep.game.timer);
  const way = new Map();
  let prev = tree.root;
  for (const n of pathTo(tree, s.node)) { way.set(prev.id, n); prev = n; }
  rep.game = { section: sid, color: s.color, tree: tree.id, way, plan: plan?.moves?.length ? plan.moves : null, comment: plan?.comment || "",
    elo: plan?.elo || repElo(), ucis: [], sans: [], fens: [START_FEN], book: [], node: tree.root.id, notes: [], over: null, thinking: false, seq: 0, timer: null };
  study.id = tree.id;
  study.node = tree.root.id;
  gameStep();
}

function repGameStop(render = true) {
  const g = rep.game;
  if (!g) return;
  clearTimeout(g.timer);
  g.seq++;
  rep.game = null;
  if (!render || !rep.on || mode !== "study") return;
  const s = repSec();
  study.id = repTree(s?.color || rep.color)?.id ?? null;
  study.node = s ? s.node : "root";
  renderStudy();
}

function gameResult(c) {
  if (c.isCheckmate()) return { score: turnOf(c.fen()) === rep.game.color ? 0 : 1, text: turnOf(c.fen()) === rep.game.color ? "Мат — ты проиграл." : "Мат — ты выиграл!" };
  const why = c.isStalemate() ? "пат" : c.isThreefoldRepetition() ? "троекратное повторение" : c.isInsufficientMaterial() ? "мало материала" : "правило 50 ходов";
  return { score: 0.5, text: `Ничья: ${why}.` };
}

// the opponent's next move from the repertoire: Claude's line while the game follows it, else the tree (null: none)
function gameBookReply() {
  const g = rep.game;
  const n = g.ucis.length;
  if (g.plan && g.plan.length > n && g.plan.slice(0, n).every((u, i) => u === g.ucis[i])) return g.plan[n];
  const node = g.node && tindex(gameTree()).get(g.node)?.n;
  if (!node?.children.length) return null;
  const w = g.way.get(node.id);
  if (w) return w.uci;
  return pickWeighted(node.children, (c) => 1 + 2 * drillWalk(g.color, c, new Set(), null, drillDue)).uci;
}

// after every move: the game may be over; on the opponent's turn it plays from the repertoire or asks Stockfish
function gameStep() {
  const g = rep.game;
  if (!g) return;
  const c = new Chess(gameFen());
  if (c.isGameOver()) { g.over = gameResult(c); renderStudy(); return; }
  renderStudy();
  if (turnOf(gameFen()) === g.color || g.over) return;
  const my = ++g.seq;
  const book = gameBookReply();
  if (book) {
    g.timer = setTimeout(() => { if (rep.game === g && g.seq === my) gamePlay(book, true); }, 550);
    return;
  }
  g.thinking = true;
  renderStudy();
  post("/api/rep/engine", { fen: gameFen(), elo: g.elo })
    .then((r) => { if (rep.game !== g || g.seq !== my) return; g.thinking = false; gamePlay(r.uci, false); })
    .catch((err) => { if (rep.game === g) { g.thinking = false; renderStudy(); } setStatus(String(err.message), true); });
}

function gamePlay(uci, book) {
  const g = rep.game;
  const before = gameFen();
  const c = new Chess(before);
  let m;
  try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { renderStudy(); return false; }
  const tree = gameTree();
  const node = g.node && tindex(tree).get(g.node)?.n;
  const ply = g.ucis.length + 1;
  const mine = turnOf(before) === g.color;
  if (node) { // still in the tree: does the move stay in it?
    const next = node.children.find((x) => x.uci === uci) || gameTreeAt(tree, c.fen());
    if (next) g.node = next.id;
    else {
      g.node = null;
      const way = g.ucis.slice();
      if (mine && node.children.length) g.notes.push({ ply, kind: "user", way, played: uci, want: node.children[0].uci, text: "Ты ушёл из репертуара" });
      else if (mine) g.notes.push({ ply, kind: "end", way, text: "Здесь твоя подготовка кончается — дальше думаешь сам" });
      else if (book) g.notes.push({ ply, kind: "opp", way, played: uci, text: "Соперник сыграл ход, которого нет в твоём дереве" });
      else g.notes.push({ ply, kind: "end", way, text: `Подготовка кончилась — дальше играет Stockfish ≈${g.elo}` });
    }
  }
  g.ucis.push(m.from + m.to + (m.promotion || ""));
  g.sans.push(m.san);
  g.fens.push(c.fen());
  g.book.push(book);
  moveSound(m.san);
  gameStep();
  return true;
}

function repGameMove(uci) { // true: the game took the move
  const g = rep.on ? rep.game : null;
  if (!g) return false;
  if (g.over || g.thinking || turnOf(gameFen()) !== g.color) { renderStudy(); return true; }
  gamePlay(uci, false);
  return true;
}

function gameTakeback() { // back to the user's last turn
  const g = rep.game;
  if (!g || g.thinking) return;
  clearTimeout(g.timer);
  g.seq++;
  const drop = () => { g.ucis.pop(); g.sans.pop(); g.fens.pop(); g.book.pop(); };
  if (g.ucis.length && turnOf(gameFen()) === g.color) drop(); // the opponent answered: take that back too
  if (g.ucis.length) drop();
  while (g.ucis.length && turnOf(gameFen()) !== g.color) drop();
  g.over = null;
  g.notes = g.notes.filter((x) => x.ply <= g.ucis.length);
  let node = gameTree().root; // where the game is in the tree again
  for (const u of g.ucis) {
    node = node && (node.children.find((x) => x.uci === u) || null);
    if (!node) break;
  }
  g.node = node?.id ?? null;
  gameStep();
}

function repGameBoard() {
  const g = rep.on ? rep.game : null;
  if (!g) return false;
  const fen = gameFen();
  const last = g.ucis.at(-1);
  const can = !g.over && !g.thinking && turnOf(fen) === g.color;
  setBoard({ fen, orientation: boardOrientation(), lastMove: last ? sq(last) : undefined,
    movable: can ? { color: g.color, dests: legalDests(fen), after: onStudyMove } : null });
  return true;
}

function repGameHtml() {
  const g = rep.game;
  const s = repSec(g.section);
  const myTurn = turnOf(gameFen()) === g.color;
  const inBook = g.book.lastIndexOf(true) + 1;
  const status = g.over ? `<div class="drill-box ${g.over.score === 1 ? "ok" : g.over.score === 0 ? "bad" : ""}">${esc(g.over.text)}</div>`
    : g.thinking ? `<div class="drill-box">Stockfish думает…</div>`
      : `<div class="drill-box">${myTurn ? "Твой ход" : "Соперник ходит…"}</div>`;
  const notes = g.notes.map((x) => {
    const at = x.way.length;
    const extra = x.kind === "user" ? `: сыграл ${repLineHtml([...x.way, x.played], { from: at, side: g.color })}, а в дереве ${repLineHtml([...x.way, x.want], { from: at, side: g.color })}`
      : x.kind === "opp" ? `: ${repLineHtml([...x.way, x.played], { from: at, side: g.color })}` : "";
    return `<div class="rg-row ${x.kind === "user" ? "user" : x.kind === "opp" ? "opponent" : ""}"><span>${esc(x.text)}${extra}.</span></div>`;
  }).join("");
  const actions = g.over
    ? `<button type="button" class="btn primary" id="game-review">${ICON.spark}Разобрать с Claude</button><button type="button" class="btn" id="game-again">Ещё партию</button><button type="button" class="btn quiet" id="game-stop2">К разделу</button>`
    : `<button type="button" class="btn" id="game-back"${g.ucis.length ? "" : " disabled"}>Ход назад</button><span class="grow"></span>
       <button type="button" class="btn quiet${rep.resignAsk ? " danger" : ""}" id="game-resign">${rep.resignAsk ? "Точно сдаться?" : "Сдаться"}</button>`;
  return `<div class="p-head"><div class="p-title"><div class="rep-crumbs"><button type="button" class="link-btn" id="game-stop">‹ Закончить партию</button></div>
      <h1 class="title">Партия с движком ${helpBtn("game")}</h1>
      <div class="rep-meta">${esc(s?.name || "")} · ты ${g.color === "white" ? "белыми" : "чёрными"} · соперник ≈${g.elo}</div></div></div>
    ${helpText("game", `Соперник ходит по твоему дереву${g.plan ? " и по варианту, который выбрал Claude" : ""}, потом — Stockfish ≈${g.elo}. Подсказок движка во время партии нет.${inBook ? ` По дереву сыграно ${inBook} ${plural(inBook, "полуход", "полухода", "полуходов")}.` : ""}`)}
    ${g.comment ? `<div class="rep-trial"><div><b>Claude:</b> ${esc(g.comment)}</div></div>` : ""}
    ${status}
    <div class="rep-path drill-line">${repLineHtml(g.ucis, { side: g.color }) || "начальная позиция"}</div>
    ${notes ? `<div class="game-notes">${notes}</div>` : ""}
    <div class="rep-actions">${actions}</div>`;
}

// the finished game: onto a board of the section's lesson (made if there is none), and Claude is asked to review it
async function gameReview() {
  const g = rep.game;
  const s = repSec(g.section);
  if (!g || !s) return;
  rep.section = s.id;
  repRemember();
  repGameStop(false);
  setChatOpen(true);
  let cid = lessonSection(ch.cur) === s.id ? ch.cur : null;
  if (!cid) cid = (await newLesson()).id;
  const moves = g.sans.map((x, i) => (i % 2 === 0 ? `${i / 2 + 1}.` : "") + x).join(" ");
  const r = await post("/api/scene", { title: `Партия с движком ≈${g.elo}`, position: "start", lines: [{ moves }], chat: cid, orientation: g.color });
  const notes = g.notes.map((x) => `- ${x.text} (полуход ${x.ply})`).join("\n");
  await post(`/api/chat/${cid}/send`, { text: `Разбери мою тренировочную партию с движком ≈${g.elo} в разделе «${s.name}» — она на доске ${r.scene}. ${g.over ? `Итог: ${g.over.text}` : ""}\n`
    + `Где партия ушла из моего репертуара и что надо было играть, потом главные ошибки после дебюта. Если в дереве не хватает ответа на ход соперника — предложи, что записать.${notes ? `\nОтметки по ходу партии:\n${notes}` : ""}` });
}

// ---- moving around ----
function repRemember() { try { localStorage.setItem("rep.section", rep.section || ""); } catch {} }

// entering «Репертуар»: the section left open last time, or the table of contents
function repEnter() {
  const s = repSec();
  if (!s) rep.section = null;
  const sc = scene();
  if (!s) {
    if (!sc?.rep) { study.id = repTree(rep.color)?.id ?? null; study.node = "root"; }
  } else {
    const fits = sc && (sc.rep === s.color || (sc.chat && lessonSection(sc.chat) === s.id));
    if (!fits) { study.id = repTree(s.color)?.id ?? null; study.node = s.node; }
    if (lessonSection(ch.cur) !== s.id) {
      const l = lessonsOf(s.id)[0]?.id ?? null; // ch.list is newest first
      if (l !== ch.cur) openChat(l, { follow: false });
    }
  }
  renderStudy();
  if (!curChat()) renderChatLog();
}

function repOpen(sid) {
  const s = repSec(sid);
  if (!s) return;
  Object.assign(rep, { section: sid, color: s.color, rename: false, del: false, form: false, tab: rep.section === sid ? rep.tab : "tree" });
  study.newpos = false;
  repRemember();
  closePreviewSilently();
  study.id = repTree(s.color)?.id ?? null;
  study.node = s.node;
  study.flipped = false;
  const l = lessonSection(ch.cur) === sid ? ch.cur : lessonsOf(sid)[0]?.id ?? null;
  if (l !== ch.cur) openChat(l, { follow: false }); else renderChatLog();
  renderStudy();
  $("#panel").scrollTop = 0;
}

function repToc() {
  Object.assign(rep, { section: null, rename: false, del: false });
  repRemember();
  closePreviewSilently();
  study.id = repTree(rep.color)?.id ?? null;
  study.node = "root";
  renderStudy();
  if (!curChat()) renderChatLog();
}

// the section's tree back on the board (the first tab above the board in a lesson)
function repShowTree() {
  const s = repSec();
  if (!s) return;
  closePreviewSilently();
  study.id = repTree(s.color)?.id ?? null;
  study.node = s.node;
  renderStudy();
}

// a board chosen in «Репертуар»: a lesson's board brings its lesson
function repFollowBoard() {
  const sc = scene();
  if (sc && !sc.rep && chatOf(sc) && sc.chat !== ch.cur) openChat(sc.chat, { follow: false });
}

// a chat opened in «Репертуар»: a lesson brings its section; another chat leaves the section as it is
function repFollowChat() {
  const sid = lessonSection(ch.cur);
  if (sid && sid !== rep.section) { repOpen(sid); return; }
  const sc = scene();
  if (sc && !sc.rep && sc.chat !== ch.cur) { // a board of the lesson left: back to the tree
    const s = repSec();
    study.id = repTree(s?.color || rep.color)?.id ?? null;
    study.node = s ? s.node : "root";
  }
  renderStudy();
}

// deleting a lesson = deleting its chat (the server drops the lesson with it); a second click within 3 s confirms
async function repDeleteLesson(id) {
  if (rep.delLesson !== id) {
    rep.delLesson = id;
    renderStudyPanel();
    setTimeout(() => { if (rep.delLesson === id) { rep.delLesson = null; if (rep.on && mode === "study") renderStudyPanel(); } }, 3000);
    return;
  }
  rep.delLesson = null;
  const sid = lessonSection(id);
  await post(`/api/chat/${id}/delete`);
  ch.entries.delete(id);
  ch.list = ch.list.filter((c) => c.id !== id);
  delete rep.data.lessons[id];
  if (ch.cur === id) openChat(lessonsOf(sid)[0]?.id ?? null, { follow: false }); else renderChatTabs();
  renderStudy();
}

async function newLesson() {
  const s = repSec();
  const c = curChat();
  const meta = await post("/api/rep/lesson", { section: s.id, model: c?.model, effort: c?.effort });
  ch.list = [meta, ...ch.list.filter((x) => x.id !== meta.id)];
  rep.data.lessons[meta.id] = { section: s.id };
  await openChat(meta.id, { follow: false });
  renderStudyPanel();
  $("#chat-text").focus();
  return meta;
}

async function repReload() {
  const d = await http.get("/api/rep");
  (d.trees || []).forEach(upsertScene);
  delete d.trees;
  Object.assign(rep.data, d);
}

async function repNewSection(color, at, name = "") {
  try {
    const r = await post("/api/rep/section", { action: "create", color, at, name });
    await repReload();
    repOpen(r.section.id);
  } catch (err) { setStatus(String(err.message), true); }
}

// a repertoire tree changed: Claude of the open chat wrote into it (shown, in «Репертуар»), or another window did
function onRepScene(ev) {
  upsertScene(ev.scene);
  rep.games = null; // the tree changed: the games are compared again
  if (isLive()) return;
  if (ev.goto && ev.by_chat && ev.by_chat === ch.cur) {
    closePreviewSilently();
    rep.section = repSectionAt(ev.scene, ev.goto) || rep.section;
    repRemember();
    study.id = ev.scene.id;
    study.node = ev.goto;
    if (!rep.on || mode !== "study") setMode("rep", { save: false }); else renderStudy();
    return;
  }
  if (rep.on && mode === "study" && study.id === ev.scene.id && ev.origin !== CLIENT) {
    if (!tindex(ev.scene).has(study.node)) study.node = "root";
    renderStudy();
  }
}

$("#panel").addEventListener("click", async (e) => {
  if (!rep.on || mode !== "study") return;
  const t = e.target.closest("[data-sec], [data-rep-toc], [data-lesson], [data-rep-tree], [data-rep-color], [data-rep-tab], #rep-form-cancel, #rep-lesson-new, #rep-lesson-go, #rep-notes, #rep-here, #rep-trial-save, #rep-trial-section, #rep-trial-drop, #drill-sec, #drill-all, #drill-again, #drill-stop, #drill-stop2, #drill-hint, #drill-why, [data-rg-goto], [data-rg-add], [data-rg-ask], [data-rg-game], [data-lesson-del], #game-stop, #game-stop2, #game-back, #game-resign, #game-review, #game-again, #rep-toc-menu, #rep-sec-menu, #rep-play-menu, #rep-puz-menu");
  if (!t) return;
  if (t.dataset.sec && e.target.closest(".mvl")) e.stopPropagation(); // the row opens its section; its moves only show on hover
  const s = repSec();
  try {
    if (t.dataset.sec) repOpen(t.dataset.sec);
    else if (t.dataset.repToc !== undefined) repToc();
    else if (t.dataset.lesson) openChat(t.dataset.lesson);
    else if (t.dataset.lessonDel) await repDeleteLesson(t.dataset.lessonDel);
    else if (t.dataset.repTab) { rep.tab = t.dataset.repTab; renderStudyPanel(); }
    else if (t.id === "rep-toc-menu") repTocMenu(t);
    else if (t.id === "rep-sec-menu" && s) repSectionMenu(t, s);
    else if (t.id === "rep-play-menu" && s) {
      openMenu(t, repPlayMenu(s), (act) => {
        if (act.startsWith("elo:")) {
          try { localStorage.setItem("rep.elo", act.slice(4)); } catch {}
          setMenu(repPlayMenu(s));
          renderStudyPanel();
          return true;
        }
        if (act === "start") gameStart(s.id);
        return false;
      });
    } else if (t.id === "rep-puz-menu" && s) {
      openMenu(t, repPuzzleMenu(s), async (act) => { if (act === "own") await repOwnPuzzles(s); else if (act === "lichess") await repLichessPuzzles(s); });
    } else if (t.id === "rep-lesson-go" && s) { // the latest lesson of the section, or a new one
      setChatOpen(true);
      const l = lessonsOf(s.id)[0];
      if (l) { if (l.id !== ch.cur) await openChat(l.id, { follow: false }); $("#chat-text").focus(); } else await newLesson();
    } else if (t.id === "rep-notes" && s) sendToChat("Покажи конспект этого раздела.");
    else if (t.id === "game-again" && rep.game) gameStart(rep.game.section);
    else if (t.id === "game-stop" || t.id === "game-stop2") repGameStop();
    else if (t.id === "game-back") gameTakeback();
    else if (t.id === "game-resign" && rep.game && !rep.game.over) {
      if (!rep.resignAsk) { // a second press resigns
        rep.resignAsk = true;
        renderStudyPanel();
        setTimeout(() => { if (rep.resignAsk) { rep.resignAsk = false; if (rep.game) renderStudyPanel(); } }, 3000);
        return;
      }
      rep.resignAsk = false;
      clearTimeout(rep.game.timer);
      rep.game.seq++;
      rep.game.thinking = false;
      rep.game.over = { score: 0, text: "Ты сдался." };
      renderStudy();
    } else if (t.id === "game-review") await gameReview();
    else if (t.dataset.repColor) {
      rep.color = t.dataset.repColor;
      study.id = repTree(rep.color)?.id ?? null;
      study.node = "root";
      renderStudy();
    } else if (t.id === "rep-form-cancel") { rep.form = false; renderStudyPanel(); }
    else if (t.id === "rep-lesson-new" && s) { setChatOpen(true); await newLesson(); }
    else if (t.id === "rep-here" && scene()?.rep) await repNewSection(scene().rep, study.node);
    else if (t.id === "rep-trial-save") await repTrialSave(false);
    else if (t.id === "rep-trial-section") await repTrialSave(true);
    else if (t.id === "rep-trial-drop") { rep.trial = null; renderStudy(); }
    else if (t.dataset.rgGoto || t.dataset.rgAdd || t.dataset.rgAsk || t.dataset.rgGame) await repGamesClick(t);
    else if (t.id === "drill-sec" && s) drillStart({ section: s.id }, !!t.dataset.practice);
    else if (t.id === "drill-all") drillStart({}, !!t.dataset.practice);
    else if (t.id === "drill-again" && rep.drill) drillStart(rep.drill.scope, true);
    else if (t.id === "drill-stop" || t.id === "drill-stop2") repDrillStop();
    else if (t.id === "drill-hint") drillHint();
    else if (t.id === "drill-why" && rep.drill?.line) {
      const L = rep.drill.line;
      const node = drillNode();
      const want = node && drillAnswer(node, L.way);
      const way = pathTo(drillTree(), node.id).map((n, i) => (n.num.endsWith(".") || i === 0 ? n.num : "") + n.san).join(" ");
      if (want) { setChatOpen(true); askClaude(`Почему в моём репертуаре ${way ? `после ${way}` : "в начальной позиции"} играется ${want.num.endsWith(".") ? want.num : ""}${want.san}?`); }
    }
  } catch (err) { setStatus(String(err.message), true); }
});

// ⋯ of the table of contents: a new opening, sections for openings met in new games
function repTocMenu(anchor) {
  openMenu(anchor, `<button type="button" class="mi" data-act="new">＋ Новый дебют</button>
    <button type="button" class="mi" data-act="seed" title="Добавить разделы для дебютов, которые встретились в новых партиях">Обновить из партий</button>`, async (act) => {
    if (act === "new") { rep.form = true; renderStudyPanel(); $("#rep-moves")?.focus(); }
    else if (act === "seed") {
      const r = await post("/api/rep/seed", {});
      setStatus(r.added ? `Новых разделов: ${r.added}` : "Новых дебютов в партиях нет");
      setTimeout(() => setStatus(""), 2500);
    }
  });
}
// ⋯ of a section: rename, Claude's notes, «не играю», delete (asks again inside the menu)
function repSectionMenu(anchor, s) {
  const items = () => `<button type="button" class="mi" data-act="rename">Переименовать</button>
    <button type="button" class="mi" data-act="notes">${ICON.spark}Показать конспект Claude</button>
    <button type="button" class="mi" data-act="retire">${s.status === "retired" ? "Снова играю" : "Больше не играю"}</button>
    <div class="menu-sep"></div>
    <button type="button" class="mi danger" data-act="del">Удалить раздел…</button>`;
  openMenu(anchor, items(), async (act) => {
    if (act === "rename") { rep.rename = true; renderStudyPanel(); $("#rep-rename-input")?.select(); }
    else if (act === "notes") sendToChat("Покажи конспект этого раздела.");
    else if (act === "retire") await post("/api/rep/section", { action: s.status === "retired" ? "restore" : "retire", id: s.id });
    else if (act === "del") { setMenu(confirmHtml(`Удалить раздел «${esc(s.name)}»?`, "Ходы останутся в дереве, уроки — в чатах.", "del-yes", "Удалить")); return true; }
    else if (act === "cancel") { setMenu(items()); return true; }
    else if (act === "del-yes") {
      await post("/api/rep/section", { action: "delete", id: s.id });
      await repReload();
      repToc();
    }
  });
}

$("#panel").addEventListener("submit", async (e) => {
  if (!rep.on || (e.target.id !== "rep-form" && e.target.id !== "rep-rename")) return;
  e.preventDefault();
  if (e.target.id === "rep-form") {
    const color = $("input[name=rep-color]:checked")?.value || "white";
    const moves = $("#rep-moves").value.trim();
    if (!moves) { $("#rep-moves").focus(); return; }
    await repNewSection(color, moves, $("#rep-name").value.trim());
    return;
  }
  const s = repSec();
  const name = $("#rep-rename-input").value.trim();
  rep.rename = false;
  if (s && name && name !== s.name) {
    try { await post("/api/rep/section", { action: "rename", id: s.id, name }); } catch (err) { setStatus(String(err.message), true); }
  } else renderStudyPanel();
});
$("#panel").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && rep.on && rep.rename) { rep.rename = false; renderStudyPanel(); }
});
// «Задачи» showing a section's puzzles: back to all of them, or back to the repertoire
$("#panel").addEventListener("click", (e) => {
  const t = e.target.closest("#puz-all, #puz-rep");
  if (!t || mode !== "puzzle") return;
  if (t.id === "puz-all") {
    pz.only = null;
    if (!pz.cur || pz.st?.result) nextPuzzle(); else renderPuzzlePanel();
  } else setMode("rep");
});


// =====================================================================
// modes, keys, server events
// =====================================================================
// a mode's badge: only what asks for the user's action — positions and puzzles due, a live game (empty = hidden)
function updateCounts() {
  $("#play-count").textContent = isLive() ? "●" : "";
  const repDue = drillDueIn({});
  $("#rep-count").textContent = repDue || "";
  const now = Date.now();
  const due = pz.list.filter((p) => pz.prog[p.id] && pz.prog[p.id].due <= now).length;
  $("#due-count").textContent = due || "";
}

// follow: which side wins when «Разбор» opens — "board" (a board was just chosen: its chat comes) or, by default,
// the open chat if it has a board (its board comes), else the board on screen
function setMode(m, { save = true, follow = "chat" } = {}) {
  if (isLive() && m !== "play") return; // during a live game only the game is on screen
  closePromotion();
  closePreviewSilently();
  const view = m; // «Репертуар» is «Разбор» with the repertoire on: the same board, tree and engine
  rep.on = m === "rep";
  if (!rep.on) { repDrillStop(false); repGameStop(false); }
  if (rep.on) m = "study";
  mode = m;
  $$(".mode").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === view)));
  $("#nav").classList.toggle("no-moves", m === "puzzle"); // a puzzle has no moves to step through: only flip (and the pencil)
  $("#ask-switch").hidden = !(m === "study" && !rep.on); // the repertoire only tries moves
  renderBoardTabs();
  if (rep.on) repEnter();
  else if (m === "study") {
    if (scene()?.rep) { study.id = activeBoard(ch.cur)?.id ?? null; study.node = "root"; } // the repertoire stays in its mode
    renderStudy();
    if (follow === "chat" && boardsOf(ch.cur).length) followChat(); else followBoard();
  } else if (m === "play") renderPlay(); else renderPuzzle();
  if (save) http.send("PUT", "/api/settings", { mode: view }).catch(() => {});
}

$$(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#flip").addEventListener("click", flip);
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nav]");
  if (b) (mode === "play" ? playStep : studyStep)(b.dataset.nav);
});
$("#auto-ask").addEventListener("change", (e) => {
  study.autoAsk = e.target.checked;
  if (!study.autoAsk) clearTimeout(askTimer);
  http.send("PUT", "/api/settings", { autoAsk: study.autoAsk }).catch(() => {});
});

function swipeStep(dir) { // what ← / → do in each mode
  if (preview) previewStep(dir);
  else if (mode === "play") playStep(dir);
  else if (mode === "study") studyStep(dir);
}

function setEngine(on) { // the switch sits in the engine block's head (cevalHtml)
  study.engine = on;
  http.send("PUT", "/api/settings", { engine: on }).catch(() => {});
  if (mode === "study") renderStudy();
}

function flip() {
  if (mode === "study") study.flipped = !study.flipped; else if (mode === "play") play.flipped = !play.flipped; else pz.flipped = !pz.flipped;
  cg.set({ orientation: boardOrientation() });
  resyncShapes();
  if (mode === "play") renderPlayPanel(); // the clocks follow the board
  renderMaterial();
  renderEvalBar();
  reportView();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (promo) { closePromotion(); return; }
    $("#ctx").hidden = true;
    $("#jobs-pop").hidden = $("#chats-pop").hidden = $("#app-menu").hidden = $("#model-pop").hidden = true;
    if (drawMode) setDrawMode(false);
    closeMenu();
    if (preview) { closePreview(); return; }
  }
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const dirs = { ArrowLeft: "prev", ArrowRight: "next", ArrowUp: "first", ArrowDown: "last", Home: "first", End: "last" };
  if (e.key === "f" || e.key === "а") { flip(); return; }
  if ((e.key === "l" || e.key === "д") && mode === "study") { setEngine(!study.engine); return; }
  if (preview && dirs[e.key]) { e.preventDefault(); previewStep(dirs[e.key]); return; }
  if (mode === "play") {
    if (dirs[e.key]) { e.preventDefault(); playStep(dirs[e.key]); }
  } else if (mode === "study") {
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); studyStep(e.key === "ArrowUp" ? "up" : "down"); return; }
    if (dirs[e.key]) { e.preventDefault(); studyStep(dirs[e.key]); }
  } else if ((e.key === "ArrowRight" || e.key === "Enter") && $("#next")) {
    e.preventDefault();
    nextPuzzle();
  }
});

function upsertScene(s) {
  const i = study.scenes.findIndex((x) => x.id === s.id);
  if (i >= 0) study.scenes[i] = s; else study.scenes.push(s);
}

async function onEvent(ev) {
  switch (ev.type) {
    case "hello": setStatus(""); reportView(); http.get("/api/lichess").then(onLive).catch(() => {}); break;
    case "live": onLive(ev.state); break;
    case "scene":
      if (ev.scene.rep) { onRepScene(ev); break; }
      upsertScene(ev.scene);
      checkPendingClaude(ev.scene);
      // a chat working in the background does not take the board away from the chat the user is in
      if (ev.goto && !isLive() && (!chatOf(ev.scene) || ev.scene.chat === ch.cur || ev.scene.id === study.id)) {
        closePreviewSilently();
        study.id = ev.scene.id;
        study.node = ev.goto;
        // a board of a lesson stays in «Репертуар»; any other board goes to «Разбор»
        if (mode !== "study" || (rep.on && !rep.data.lessons[ev.scene.chat])) setMode("study", { save: false, follow: "board" });
        else { renderStudy(); followBoard(); }
      } else if (mode === "study" && study.id === ev.scene.id && ev.origin !== CLIENT) {
        if (!tindex(ev.scene).has(study.node)) study.node = "root";
        renderStudy();
      }
      updateCounts();
      break;
    case "goto": {
      const sc = study.scenes.find((s) => s.id === ev.scene);
      if (isLive() || (chatOf(sc) && sc.chat !== ch.cur && sc.id !== study.id)) break;
      closePreviewSilently();
      study.id = ev.scene;
      study.node = ev.node;
      if (mode !== "study") setMode("study", { save: false, follow: "board" }); else { renderStudy(); followBoard(); }
      break;
    }
    case "scenes": {
      const s = await http.get("/api/state");
      study.scenes = [...s.study.scenes, ...(s.rep?.trees || [])];
      if (scene() || !study.id) { if (mode === "study") renderStudy(); } // nothing gone from the screen (an empty board stays empty)
      else { // the board on screen was deleted in another window: another board of the same chat, never another chat
        study.id = activeBoard(chatOf({ chat: ch.cur }))?.id ?? null;
        study.node = "root";
        renderStudy();
      }
      break;
    }
    case "chat_board": // the board a chat's Claude works on by default; opening that chat brings it
      study.chatBoard[ev.chat] = ev.scene;
      break;
    case "mode":
      if (ev.puzzle && pz.byId[ev.puzzle]) { mode = ev.mode; loadPuzzle(pz.byId[ev.puzzle]); }
      setMode(ev.mode, { save: false });
      break;
    case "puzzles": {
      const list = await http.get("/api/puzzles");
      pz.list = list;
      pz.byId = Object.fromEntries(list.map((p) => [p.id, p]));
      assignRatings(list);
      if (mode === "puzzle") renderPuzzlePanel();
      updateCounts();
      break;
    }
    case "job": {
      const i = jobsState.list.findIndex((j) => j.id === ev.job.id);
      const was = i >= 0 ? jobsState.list[i].status : null;
      if (i >= 0) jobsState.list[i] = ev.job; else jobsState.list.push(ev.job);
      if (was === "running" && ev.job.status !== "running") { // just ended: its result shows for a few seconds
        jobsState.endedAt = Date.now();
        setTimeout(renderJobChip, JOB_SHOW_MS + 50);
      }
      renderJobChip();
      renderJobsPop();
      renderAppMenu();
      if (ev.job.kind === "fetch_games" && ev.job.status !== "running" && play.hist) { play.hist = null; renderPlayPanel(); } // new games in the list
      if (ev.job.kind === "fetch_games" && ev.job.status === "done") { rep.games = null; if (rep.on && mode === "study" && !rep.drill) renderStudyPanel(); }
      break;
    }
    case "play": { // test hook: a move as if the user made it
      const c = new Chess(shownFen);
      let m = null;
      try { m = c.move(ev.move); } catch { try { m = c.move({ from: ev.move.slice(0, 2), to: ev.move.slice(2, 4), promotion: ev.move[4] }); } catch {} }
      if (!m) break;
      if (mode === "study") onStudyMove(m.from, m.to);
      else if (mode === "play") onPlayMove(m.from, m.to);
      else if (pz.cur && !pz.st.result) onPuzzleMove(m.from, m.to);
      break;
    }
    case "chat_list": case "chat_entry": case "chat_delta": onChatEvent(ev); break;
    case "rep_play": // Claude of the open chat started a training game
      if (ev.by_chat && ev.by_chat === ch.cur && !isLive() && repSec(ev.section)) {
        rep.section = ev.section;
        repRemember();
        if (!rep.on || mode !== "study") setMode("rep", { save: false });
        gameStart(ev.section, { moves: ev.moves, comment: ev.comment, elo: ev.elo });
      }
      break;
    case "rep_drill": rep.data.drill[ev.key] = ev.card; updateCounts(); if (rep.on && mode === "study" && !rep.drill) renderStudyPanel(); break;
    case "rep": Object.assign(rep.data, ev.rep); if (rep.on && mode === "study") { renderStudyPanel(); if (!curChat()) renderChatLog(); } break;
    case "reload": location.reload(); break;
    case "closed_chats": // a tab closed or reopened in another window (the Mac or the iPad)
      closedChats = new Set(ev.ids || []);
      renderChatTabs();
      break;
    case "eval": { // test harness: only a server started with COACH_DEBUG=1 sends this
      let result;
      try { result = await new Function(`return (async () => { ${ev.js} })()`)(); } catch (err) { result = `error: ${err.message}`; }
      post("/api/debug/result", { id: ev.id, result }).catch(() => {});
      break;
    }
  }
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onerror = () => setStatus("нет связи с сервером — переподключаюсь…", true);
}

async function init() {
  try {
    const [s, list] = await Promise.all([http.get("/api/state"), http.get("/api/puzzles")]);
    study.scenes = [...(s.study.scenes || []), ...(s.rep?.trees || [])]; // the repertoire's trees are boards too (coach/repertoire.py)
    Object.assign(rep.data, s.rep || {});
    try { rep.section = localStorage.getItem("rep.section") || null; } catch {}
    study.chatBoard = s.settings.chat_boards || {};
    study.id = s.study.current || study.scenes.at(-1)?.id || null;
    study.engine = !!s.settings.engine;
    study.autoAsk = s.settings.autoAsk !== false;
    $("#auto-ask").checked = study.autoAsk;
    pz.list = list;
    pz.byId = Object.fromEntries(list.map((p) => [p.id, p]));
    assignRatings(list);
    Object.assign(ladder, s.settings.ladder || {});
    pz.prog = s.progress || {};
    pz.filt = { ...pz.filt, ...(s.settings.filter || {}) };
    if (Array.isArray(s.settings.recent)) recent = [...new Set([...s.settings.recent, ...recent])].slice(-60);
    if (s.settings.puzzle && pz.byId[s.settings.puzzle]) loadPuzzle(pz.byId[s.settings.puzzle]);
    ch.list = s.chats || [];
    ch.models = s.models || [];
    ch.efforts = s.efforts || [];
    jobsState.list = s.jobs || [];
    jobsState.kinds = s.job_kinds || {};
    if (jobsState.list.at(-1)?.status === "failed") jobsState.failSeen = jobsState.list.at(-1).id; // an old failure stays in the log
    play.st = s.live || null;
    if (play.st?.game?.playing) play.show = play.st.game.id;
    applyLock();
    let saved = null, open = "1";
    try { saved = localStorage.getItem("chat.cur"); open = localStorage.getItem("chat.open") ?? "1"; } catch {}
    setChatOpen(open !== "0");
    if (Array.isArray(s.settings.closed_chats)) closedChats = new Set(s.settings.closed_chats);
    else { // the first start since closed tabs moved to the server: this window's own list, if it has one
      try { closedChats = new Set(JSON.parse(localStorage.getItem("chat.closed") || "[]")); } catch {}
      if (closedChats.size) saveClosed();
    }
    const openList = ch.list.filter((c) => !closedChats.has(c.id));
    await openChat(openList.some((c) => c.id === saved) ? saved : openList[0]?.id || null, { follow: false }); // in «Разбор» setMode brings the board's chat
    renderJobChip();
    setMode(isLive() ? "play" : ["study", "play", "rep"].includes(s.settings.mode) ? s.settings.mode : "puzzle", { save: false });
  } catch (e) {
    $("#panel").innerHTML = `<p class="empty">Не удалось загрузить данные: ${esc(e.message)}</p>`;
  }
  connect();
  appReady();
  // A chat the native shell asked for before this script ran (it may run after the page reports loaded).
  if (window.coachPendingChat) {
    const id = window.coachPendingChat;
    delete window.coachPendingChat;
    window.coachOpenChat(id);
  }
}

let appReady;
const ready = new Promise((r) => { appReady = r; });

// The native shell calls this for chess-coach://chat?id=<chat id> (a click in the Claude Limits menu bar app),
// or leaves the id in window.coachPendingChat when this script has not run yet.
// No chat during a live game: the app only comes forward.
window.coachOpenChat = async (id) => {
  await ready;
  if (isLive()) return;
  if (!ch.list.some((c) => c.id === id)) {
    try { ch.list = (await http.get("/api/state")).chats || ch.list; } catch {}
  }
  if (!ch.list.some((c) => c.id === id)) return;
  setChatOpen(true);
  await openChat(id);
};

init();
