const params = new URLSearchParams(window.location.search);
const bookId = params.get('id');

const readerBody = document.getElementById('readerBody');
const readerLoading = document.getElementById('readerLoading');
const readerTitle = document.getElementById('readerTitle');
const selectionBubble = document.getElementById('selectionBubble');
const aiPanel = document.getElementById('aiPanel');
const aiSourceText = document.getElementById('aiSourceText');
const aiAnswerArea = document.getElementById('aiAnswerArea');

const HIGHLIGHT_COLORS = ['#FFD400', '#2ECC40', '#1E90FF', '#FF2D95', '#FF3B30'];
const ERASE_RADIUS_PX = 14; // hit-test radius, in on-screen page pixels
let activeColor = HIGHLIGHT_COLORS[0];
let mode = 'select'; // 'select' | 'draw' | 'erase'
let book = null;
let pdfDoc = null;
let pageEls = {}; // page number -> { wrap, canvas, textLayer, annoLayer, drawCanvas, viewport }
let saveProgressTimer = null;
let currentVisiblePage = 1;
let pendingSelectionRange = null;

init();

async function init() {
  if (!bookId) {
    readerLoading.textContent = 'No book selected.';
    return;
  }
  const res = await fetch(`/api/books/${bookId}`);
  if (!res.ok) {
    readerLoading.textContent = 'Book not found.';
    return;
  }
  book = await res.json();
  readerTitle.textContent = book.title;
  document.title = book.title;

  buildColorSwatches();
  wireToolbar();
  wireSelectionBubble();
  wireAiPanel();

  try {
    if (book.fileType === 'pdf') {
      await openPdf();
    } else {
      readerLoading.textContent = 'EPUB support is basic in this build — rendering as plain text.';
      await openEpubFallback();
    }
  } catch (err) {
    let msg = err && err.message ? err.message : 'Could not open this book.';
    try {
      const r = await fetch(`/api/books/${bookId}/file`, { method: 'HEAD' });
      if (r.status === 404) {
        const j = await (await fetch(`/api/books/${bookId}/file`)).json();
        msg = j.error || msg;
      }
    } catch (_) {}
    if (readerLoading.isConnected) readerLoading.textContent = msg;
  }
}

function buildColorSwatches() {
  const container = document.getElementById('colorSwatches');
  HIGHLIGHT_COLORS.forEach((color, i) => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (i === 0 ? ' active' : '');
    sw.style.background = color;
    sw.addEventListener('click', () => {
      activeColor = color;
      document.querySelectorAll('.color-swatch').forEach((el) => el.classList.remove('active'));
      sw.classList.add('active');
    });
    container.appendChild(sw);
  });
}

function wireToolbar() {
  const selectBtn = document.getElementById('toolSelect');
  const drawBtn = document.getElementById('toolDraw');
  const eraseBtn = document.getElementById('toolErase');
  const fsBtn = document.getElementById('toolFullscreen');
  const aiBtn = document.getElementById('toolAi');

  function setMode(newMode) {
    mode = newMode;
    [selectBtn, drawBtn, eraseBtn].forEach((b) => b.classList.remove('active'));
    if (newMode === 'select') selectBtn.classList.add('active');
    if (newMode === 'draw') drawBtn.classList.add('active');
    if (newMode === 'erase') eraseBtn.classList.add('active');
    Object.values(pageEls).forEach(({ drawCanvas, textLayer }) => {
      drawCanvas.style.pointerEvents = newMode === 'draw' || newMode === 'erase' ? 'auto' : 'none';
      textLayer.style.pointerEvents = newMode === 'select' ? 'auto' : 'none';
    });
  }
  selectBtn.addEventListener('click', () => setMode('select'));
  drawBtn.addEventListener('click', () => setMode('draw'));
  eraseBtn.addEventListener('click', () => setMode(mode === 'erase' ? 'select' : 'erase'));
  setMode('select');

  fsBtn.addEventListener('click', () => {
    const root = document.getElementById('readerRoot');
    if (!document.fullscreenElement) root.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  });

  aiBtn.addEventListener('click', () => {
    const sel = window.getSelection().toString().trim();
    if (sel) openAiPanel(sel);
    else openAiPanel('');
  });
}

/* ---------------- PDF rendering ---------------- */

async function openPdf() {
  const url = `/api/books/${bookId}/file`;
  const loadingTask = pdfjsLib.getDocument(url);
  pdfDoc = await loadingTask.promise;
  readerLoading.remove();

  const totalPages = pdfDoc.numPages;
  if (!book.totalPages || book.totalPages !== totalPages) {
    fetch(`/api/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalPages })
    });
  }

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    await renderPdfPage(pageNum);
  }

  setupScrollTracking(totalPages);
  restoreScrollPosition();
}

async function renderPdfPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.4 });

  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = pageNum;
  wrap.style.width = viewport.width + 'px';
  wrap.style.height = viewport.height + 'px';

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';
  textLayer.style.width = viewport.width + 'px';
  textLayer.style.height = viewport.height + 'px';

  const annoLayer = document.createElement('div');
  annoLayer.className = 'annotation-layer';

  const drawCanvas = document.createElement('canvas');
  drawCanvas.className = 'draw-canvas';
  drawCanvas.width = viewport.width;
  drawCanvas.height = viewport.height;
  drawCanvas.style.pointerEvents = 'none';

  const badge = document.createElement('div');
  badge.className = 'page-number-badge';
  badge.textContent = `Page ${pageNum} of ${pdfDoc.numPages}`;

  wrap.appendChild(canvas);
  wrap.appendChild(annoLayer);
  wrap.appendChild(drawCanvas);
  wrap.appendChild(textLayer);
  wrap.appendChild(badge);
  readerBody.appendChild(wrap);

  pageEls[pageNum] = { wrap, canvas, textLayer, annoLayer, drawCanvas, viewport };

  await page.render({ canvasContext: ctx, viewport }).promise;

  const textContent = await page.getTextContent();
  renderTextLayer(textContent, viewport, textLayer);

  wireDrawCanvas(pageNum, drawCanvas, viewport);
  wireTextSelection(pageNum, textLayer);

  await loadAnnotationsForPage(pageNum);
}

function renderTextLayer(textContent, viewport, textLayer) {
  textContent.items.forEach((item) => {
    const tx = pdfjsLib.Util.transform(
      pdfjsLib.Util.transform(viewport.transform, item.transform),
      [1, 0, 0, -1, 0, 0]
    );
    const span = document.createElement('span');
    span.textContent = item.str;
    const fontSize = Math.hypot(tx[2], tx[3]);
    span.style.left = tx[4] + 'px';
    span.style.top = (tx[5] - fontSize) + 'px';
    span.style.fontSize = fontSize + 'px';
    span.style.fontFamily = 'sans-serif';
    textLayer.appendChild(span);
  });
}

/* ---------------- Text selection -> highlight / AI ---------------- */

function wireTextSelection(pageNum, textLayer) {
  textLayer.addEventListener('mouseup', () => {
    if (mode !== 'select') return;
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text) { selectionBubble.style.display = 'none'; return; }

    const range = sel.getRangeAt(0);
    pendingSelectionRange = { pageNum, range, text };

    const rect = range.getBoundingClientRect();
    selectionBubble.style.display = 'flex';
    selectionBubble.style.left = Math.max(8, rect.left) + 'px';
    selectionBubble.style.top = Math.max(8, rect.top - 44) + 'px';
  });
}

function wireSelectionBubble() {
  document.getElementById('bubbleHighlight').addEventListener('click', () => {
    if (pendingSelectionRange) saveHighlightFromSelection(pendingSelectionRange);
    selectionBubble.style.display = 'none';
    window.getSelection().removeAllRanges();
  });
  document.getElementById('bubbleAsk').addEventListener('click', () => {
    if (pendingSelectionRange) openAiPanel(pendingSelectionRange.text);
    selectionBubble.style.display = 'none';
  });
  document.addEventListener('mousedown', (e) => {
    if (!selectionBubble.contains(e.target)) selectionBubble.style.display = 'none';
  });
}

async function saveHighlightFromSelection({ pageNum, range, text }) {
  const { viewport, wrap } = pageEls[pageNum];
  const wrapRect = wrap.getBoundingClientRect();
  const clientRects = Array.from(range.getClientRects());

  const rects = clientRects.map((r) => ({
    x: (r.left - wrapRect.left) / viewport.width,
    y: (r.top - wrapRect.top) / viewport.height,
    w: r.width / viewport.width,
    h: r.height / viewport.height
  }));

  const res = await fetch('/api/annotations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId, page: pageNum, type: 'highlight', color: activeColor, rects, text })
  });
  const annotation = await res.json();
  drawHighlight(pageNum, annotation);
}

function drawHighlight(pageNum, annotation) {
  const { annoLayer, viewport, highlights } = pageEls[pageNum];
  const group = document.createElement('div');
  group.dataset.annoId = annotation._id;
  group.style.position = 'absolute';
  group.style.inset = '0';
  group.style.pointerEvents = 'none'; // erasing is handled by the draw canvas above it, not by clicking this

  annotation.rects.forEach((r) => {
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.left = (r.x * viewport.width) + 'px';
    box.style.top = (r.y * viewport.height) + 'px';
    box.style.width = (r.w * viewport.width) + 'px';
    box.style.height = (r.h * viewport.height) + 'px';
    box.style.background = annotation.color;
    box.style.opacity = '0.6';
    box.style.mixBlendMode = 'multiply';
    box.style.borderRadius = '2px';
    group.appendChild(box);
  });

  pageEls[pageNum].annoLayer.appendChild(group);
  highlights.push({ id: annotation._id, rects: annotation.rects, el: group });
}

function removeHighlight(pageNum, highlight) {
  highlight.el.remove();
  pageEls[pageNum].highlights = pageEls[pageNum].highlights.filter((h) => h.id !== highlight.id);
  fetch(`/api/annotations/${highlight.id}`, { method: 'DELETE' }).catch(() => {});
}

/* ---------------- Drawing + hover-erase ---------------- */

function wireDrawCanvas(pageNum, drawCanvas, viewport) {
  const ctx = drawCanvas.getContext('2d');
  let active = false;
  let currentPoints = [];

  function toRatio(e) {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height
    };
  }

  function handleDown(e) {
    if (mode === 'draw') {
      active = true;
      currentPoints = [toRatio(e)];
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(currentPoints[0].x * viewport.width, currentPoints[0].y * viewport.height);
    } else if (mode === 'erase') {
      active = true;
      eraseAt(pageNum, toRatio(e));
    }
  }

  function handleMove(e) {
    if (!active) return;
    if (mode === 'draw') {
      const p = toRatio(e);
      currentPoints.push(p);
      ctx.lineTo(p.x * viewport.width, p.y * viewport.height);
      ctx.stroke();
    } else if (mode === 'erase') {
      eraseAt(pageNum, toRatio(e));
    }
  }

  async function handleUp() {
    if (!active) return;
    active = false;
    if (mode === 'draw' && currentPoints.length > 1) {
      const pointsToSave = currentPoints;
      currentPoints = [];
      const res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bookId, page: pageNum, type: 'drawing', color: activeColor, points: pointsToSave, strokeWidth: 3 })
      });
      const annotation = await res.json();
      pageEls[pageNum].strokes.push({ id: annotation._id, points: pointsToSave, color: activeColor, strokeWidth: 3 });
    }
    currentPoints = [];
  }

  drawCanvas.addEventListener('pointerdown', handleDown);
  drawCanvas.addEventListener('pointermove', handleMove);
  drawCanvas.addEventListener('pointerup', handleUp);
  drawCanvas.addEventListener('pointerleave', handleUp);
}

// Hit-tests the eraser position (ratio coords) against this page's strokes and
// highlight rects, in pixel space, and removes anything within ERASE_RADIUS_PX.
function eraseAt(pageNum, ratioPoint) {
  const { viewport, strokes, highlights } = pageEls[pageNum];
  const px = ratioPoint.x * viewport.width;
  const py = ratioPoint.y * viewport.height;

  let strokesChanged = false;
  const remainingStrokes = [];
  for (const stroke of strokes) {
    if (strokeNearPoint(stroke.points, viewport, px, py, ERASE_RADIUS_PX)) {
      strokesChanged = true;
      fetch(`/api/annotations/${stroke.id}`, { method: 'DELETE' }).catch(() => {});
    } else {
      remainingStrokes.push(stroke);
    }
  }
  if (strokesChanged) {
    pageEls[pageNum].strokes = remainingStrokes;
    repaintStrokes(pageNum);
  }

  // Erase highlights whose rect the eraser is currently over
  const pad = ERASE_RADIUS_PX * 0.6;
  for (const h of [...highlights]) {
    const hit = h.rects.some((r) => {
      const x0 = r.x * viewport.width - pad;
      const y0 = r.y * viewport.height - pad;
      const x1 = x0 + r.w * viewport.width + pad * 2;
      const y1 = y0 + r.h * viewport.height + pad * 2;
      return px >= x0 && px <= x1 && py >= y0 && py <= y1;
    });
    if (hit) removeHighlight(pageNum, h);
  }
}

function strokeNearPoint(points, viewport, px, py, radius) {
  if (!points || points.length === 0) return false;
  if (points.length === 1) {
    const dx = points[0].x * viewport.width - px;
    const dy = points[0].y * viewport.height - py;
    return Math.hypot(dx, dy) <= radius;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x * viewport.width;
    const ay = points[i].y * viewport.height;
    const bx = points[i + 1].x * viewport.width;
    const by = points[i + 1].y * viewport.height;
    if (distToSegment(px, py, ax, ay, bx, by) <= radius) return true;
  }
  return false;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function repaintStrokes(pageNum) {
  const { drawCanvas, viewport, strokes } = pageEls[pageNum];
  const ctx = drawCanvas.getContext('2d');
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  strokes.forEach((s) => {
    if (!s.points || s.points.length < 2) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.strokeWidth || 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * viewport.width, s.points[0].y * viewport.height);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x * viewport.width, s.points[i].y * viewport.height);
    }
    ctx.stroke();
  });
}

/* ---------------- Load existing annotations ---------------- */

async function loadAnnotationsForPage(pageNum) {
  pageEls[pageNum].strokes = [];
  pageEls[pageNum].highlights = [];

  const res = await fetch(`/api/annotations/book/${bookId}?page=${pageNum}`);
  const annotations = await res.json();

  annotations.forEach((a) => {
    if (a.type === 'highlight') {
      drawHighlight(pageNum, a);
    } else if (a.type === 'drawing' && a.points && a.points.length > 1) {
      pageEls[pageNum].strokes.push({ id: a._id, points: a.points, color: a.color, strokeWidth: a.strokeWidth || 3 });
    }
  });

  repaintStrokes(pageNum);
}

/* ---------------- Scroll tracking / resume position ---------------- */

function setupScrollTracking(totalPages) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          currentVisiblePage = Number(entry.target.dataset.page);
          scheduleSaveProgress();
        }
      });
    },
    { threshold: [0.5] }
  );
  Object.values(pageEls).forEach(({ wrap }) => observer.observe(wrap));
}

function scheduleSaveProgress() {
  clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(() => {
    const scrollRatio = readerBody.scrollTop / Math.max(1, readerBody.scrollHeight - readerBody.clientHeight);
    fetch(`/api/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastPage: currentVisiblePage, lastScrollRatio: scrollRatio })
    });
  }, 600);
}

readerBody.addEventListener('scroll', scheduleSaveProgress);

function restoreScrollPosition() {
  const target = pageEls[book.lastPage];
  if (target) {
    target.wrap.scrollIntoView({ block: 'start' });
  }
}

/* ---------------- Simple EPUB fallback (text extraction, no pagination) ---------------- */

async function openEpubFallback() {
  readerBody.innerHTML = `
    <div style="max-width:720px; color:#eef0f6; padding: 10px;">
      <p style="color:#9aa0b4; font-size:13px;">
        This build renders EPUB as a single continuous page so highlighting and drawing still work the same way
        as PDF. For richer EPUB pagination, swap in epub.js later.
      </p>
      <div id="epubContent" style="background:white; color:#111; border-radius:12px; padding:28px; line-height:1.7;"></div>
    </div>`;
  const el = document.getElementById('epubContent');
  el.textContent = 'EPUB rendering requires the epub.js library — add it to reader.html to enable full EPUB support. For now, PDF is fully supported end-to-end.';
}

/* ---------------- AI panel ---------------- */

function wireAiPanel() {
  document.getElementById('closeAiPanel').addEventListener('click', () => aiPanel.classList.remove('open'));
  document.getElementById('aiFollowupBtn').addEventListener('click', sendFollowup);
  document.getElementById('aiFollowupInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendFollowup();
  });
}

let currentAiText = '';

function openAiPanel(selectedText) {
  currentAiText = selectedText;
  aiSourceText.textContent = selectedText || '(No text selected — type a question below.)';
  aiAnswerArea.innerHTML = '';
  aiPanel.classList.add('open');
  if (selectedText) askAi(selectedText, null);
}

async function askAi(text, question) {
  aiAnswerArea.innerHTML = `<div class="ai-loading"><div class="spinner"></div> Thinking…</div>`;
  try {
    const res = await fetch('/api/ai/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, question })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    aiAnswerArea.innerHTML = `<div class="ai-answer"></div>`;
    aiAnswerArea.querySelector('.ai-answer').textContent = data.explanation;
  } catch (err) {
    aiAnswerArea.innerHTML = `<div class="ai-answer" style="color:#ff8787;">${err.message}</div>`;
  }
}

function sendFollowup() {
  const input = document.getElementById('aiFollowupInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  askAi(currentAiText || q, currentAiText ? q : null);
}


/* ---------------- End reading ---------------- */

const endReadingBtn = document.getElementById('endReading');
endReadingBtn.addEventListener('click', async () => {
  if (!book) return;
  endReadingBtn.disabled = true;
  clearTimeout(saveProgressTimer);
  const stoppedAt = currentVisiblePage;
  const scrollRatio = readerBody.scrollTop / Math.max(1, readerBody.scrollHeight - readerBody.clientHeight);
  const body = { lastPage: stoppedAt, lastScrollRatio: scrollRatio };
  if (pdfDoc) body.totalPages = pdfDoc.numPages;
  endReadingBtn.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    });
    if (!res.ok) throw new Error('Save failed');
    endReadingBtn.textContent = `Saved · page ${stoppedAt}`;
    setTimeout(() => { window.location.href = '/'; }, 700);
  } catch (err) {
    endReadingBtn.disabled = false;
    endReadingBtn.textContent = 'End reading';
    alert('Could not save your page. Check your connection and try again.');
  }
});
