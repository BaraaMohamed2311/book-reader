const params = new URLSearchParams(window.location.search);
const bookId = params.get('id');

const readerBody = document.getElementById('readerBody');
const readerLoading = document.getElementById('readerLoading');
const readerTitle = document.getElementById('readerTitle');
const aiPanel = document.getElementById('aiPanel');
const aiSourceText = document.getElementById('aiSourceText');
const aiAnswerArea = document.getElementById('aiAnswerArea');

const HIGHLIGHT_COLORS = ['#FFD400', '#2ECC40', '#1E90FF', '#FF2D95', '#FF3B30'];
const ERASE_RADIUS_PX = 14; // hit-test radius, in on-screen page pixels
let activeColor = HIGHLIGHT_COLORS[0];
// 'read' is the default: nothing is armed, the page behaves like a normal
// scrollable/zoomable document. Arming a tool (tapping it) switches into
// 'draw' | 'erase' | 'highlight' | 'ai' | 'note' — in any of those, dragging
// a finger/pointer over the page acts immediately (paints a stroke, erases
// what's under it, highlights the text dragged over, asks the AI about it,
// or saves it as a word/quote). Tapping the same tool again drops back to
// 'read'.
let mode = 'read';
let book = null;
let pdfDoc = null;
let pageEls = {}; // page number -> { wrap, canvas, textLayer, annoLayer, drawCanvas, viewport }
let saveProgressTimer = null;
let currentVisiblePage = 1;

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
  wirePageJump();
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

const MODE_HINTS = {
  draw: 'Draw mode — drag anywhere on the page to draw. Tap 🖊 again to stop.',
  erase: 'Eraser mode — drag over a highlight or drawing to remove it. Tap ⌫ again to stop.',
  highlight: 'Highlight mode — drag over text to highlight it. Tap 🖍 again to stop.',
  ai: 'Ask AI mode — drag over text to ask about it. Tap 🤖 again to stop.',
  note: 'Save mode — drag over text to save it as a word or quote. Tap 📝 again to stop.'
};

function setMode(newMode) {
  // Abandon any drag in progress on the tool being switched away from.
  endDrag(false);
  mode = newMode;

  document.querySelectorAll('.toolbar .btn-icon[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === newMode);
  });

  const hint = document.getElementById('modeHint');
  if (hint) {
    if (MODE_HINTS[newMode]) {
      hint.textContent = MODE_HINTS[newMode];
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }

  Object.values(pageEls).forEach(({ drawCanvas, textLayer }) => {
    drawCanvas.style.pointerEvents = (newMode === 'draw' || newMode === 'erase') ? 'auto' : 'none';
    textLayer.style.pointerEvents = (newMode === 'highlight' || newMode === 'ai' || newMode === 'note') ? 'auto' : 'none';
  });
}

function wireToolbar() {
  const fsBtn = document.getElementById('toolFullscreen');

  // Every tool button behaves the same way: tapping it arms that tool
  // (exclusively — arming one disarms any other), tapping the same one
  // again drops back to plain reading. Draw/Erase already worked this way;
  // Highlight/Ask AI/Note now do too, via drag (wired in wireSpanDrag).
  document.querySelectorAll('.toolbar .btn-icon[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setMode(mode === btn.dataset.tool ? 'read' : btn.dataset.tool);
    });
  });

  fsBtn.addEventListener('click', () => {
    const root = document.getElementById('readerRoot');
    if (!document.fullscreenElement) root.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  });

  setMode('read');
}

/* ---------------- PDF rendering ---------------- */

async function openPdf() {
  const url = `/api/books/${bookId}/file`;
  const loadingTask = pdfjsLib.getDocument(url);
  pdfDoc = await loadingTask.promise;
  readerLoading.remove();

  const totalPages = pdfDoc.numPages;
  updatePageIndicator();
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

  setupScrollTracking();
  restoreScrollPosition();
}

const BASE_PDF_SCALE = 1.4;

// On phones a page rendered at the desktop scale is wider than the screen.
// .reader-body clips overflow-x instead of scrolling it, so the right edge
// of every page was getting silently cut off. Fit the scale to the actual
// available width instead (capped at the normal desktop scale) so the whole
// page is visible and nothing needs to scroll sideways.
function pdfScaleFor(baseViewport) {
  const horizontalPadding = 24; // matches .reader-body's 12px left/right padding
  const available = readerBody.clientWidth - horizontalPadding;
  if (available <= 0) return BASE_PDF_SCALE;
  const fitScale = available / baseViewport.width;
  return Math.min(BASE_PDF_SCALE, fitScale);
}

// Canvases are bitmaps: sizing one's width/height attribute to the page's
// CSS (logical) pixel size only looks sharp on old 1x screens. On a normal
// phone (devicePixelRatio 2-3) that leaves far fewer bitmap pixels than the
// screen can actually show, so text renders fuzzy — worse the smaller the
// fitted CSS size gets. Render the bitmap at devicePixelRatio instead, and
// keep the element's on-page (CSS) size at the logical viewport size via
// canvas.style.width/height, so layout is unaffected and only sharpness
// changes. Capped at 2x: beyond that the gain is imperceptible but the
// memory cost (the whole book is rendered up front) is not.
const OUTPUT_SCALE = Math.min(window.devicePixelRatio || 1, 2);

async function renderPdfPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: pdfScaleFor(baseViewport) });

  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = pageNum;
  wrap.style.width = viewport.width + 'px';
  wrap.style.height = viewport.height + 'px';

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = Math.ceil(viewport.width * OUTPUT_SCALE);
  canvas.height = Math.ceil(viewport.height * OUTPUT_SCALE);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  const ctx = canvas.getContext('2d');

  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';
  textLayer.style.width = viewport.width + 'px';
  textLayer.style.height = viewport.height + 'px';

  const annoLayer = document.createElement('div');
  annoLayer.className = 'annotation-layer';

  // Drawing (pen) also gets a sharp backing store; a context-level scale
  // keeps all the existing draw/erase math (which works in logical,
  // viewport.width-relative units) correct without touching it.
  const drawCanvas = document.createElement('canvas');
  drawCanvas.className = 'draw-canvas';
  drawCanvas.width = Math.ceil(viewport.width * OUTPUT_SCALE);
  drawCanvas.height = Math.ceil(viewport.height * OUTPUT_SCALE);
  drawCanvas.style.width = viewport.width + 'px';
  drawCanvas.style.height = viewport.height + 'px';
  drawCanvas.style.pointerEvents = 'none';
  drawCanvas.getContext('2d').scale(OUTPUT_SCALE, OUTPUT_SCALE);

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

  const renderTransform = OUTPUT_SCALE !== 1 ? [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0] : undefined;
  await page.render({ canvasContext: ctx, viewport, transform: renderTransform }).promise;

  const textContent = await page.getTextContent();
  renderTextLayer(textContent, viewport, textLayer);

  wireDrawCanvas(pageNum, drawCanvas, viewport);
  wireSpanDrag(pageNum, textLayer);

  await loadAnnotationsForPage(pageNum);

  if (pendingJump === pageNum) jumpToPage(pageNum);
  else if (pageNum === 1) updatePageIndicator();
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

/* ---------------- Text tools (Highlight / Ask AI / Note) via drag ---------------- */

// There is no floating or side menu, and no browser text selection involved
// at all: while Highlight, Ask AI or Note is armed, dragging a finger/mouse
// over the text layer picks up whichever word spans it passes over (via
// elementFromPoint, not window.getSelection()) and the matching action runs
// the moment the drag ends. Because the native selection is never touched,
// the OS's own copy/select-all/web-search bar never has a reason to appear.
let activeDrag = null; // { pageNum, spans, startIndex, currentIndex, previewEls }

function textLayerSpans(pageNum) {
  return Array.from(pageEls[pageNum].textLayer.children);
}

function spanIndexAtPoint(pageNum, clientX, clientY) {
  const { textLayer } = pageEls[pageNum];
  const el = document.elementFromPoint(clientX, clientY);
  const span = el && el.closest ? el.closest('span') : null;
  if (!span || span.parentElement !== textLayer) return -1;
  return Array.from(textLayer.children).indexOf(span);
}

function renderActiveDragPreview() {
  if (!activeDrag) return;
  const { pageNum, spans, startIndex, currentIndex, previewEls } = activeDrag;
  previewEls.forEach((el) => el.remove());
  activeDrag.previewEls = [];
  const { wrap, annoLayer } = pageEls[pageNum];
  const wrapRect = wrap.getBoundingClientRect();
  const lo = Math.min(startIndex, currentIndex);
  const hi = Math.max(startIndex, currentIndex);
  for (let i = lo; i <= hi; i++) {
    const r = spans[i].getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'selection-preview-box';
    box.style.left = (r.left - wrapRect.left) + 'px';
    box.style.top = (r.top - wrapRect.top) + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    annoLayer.appendChild(box);
    activeDrag.previewEls.push(box);
  }
}

function clearActiveDragPreview() {
  if (!activeDrag) return;
  activeDrag.previewEls.forEach((el) => el.remove());
  activeDrag.previewEls = [];
}

// Text + per-span rects (same {x,y,w,h} ratio format the annotation API and
// drawHighlight already use) for whatever the current drag spans.
function activeDragSelection() {
  if (!activeDrag) return null;
  const { pageNum, spans, startIndex, currentIndex } = activeDrag;
  const lo = Math.min(startIndex, currentIndex);
  const hi = Math.max(startIndex, currentIndex);
  const picked = spans.slice(lo, hi + 1);
  const text = picked.map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const { wrap, viewport } = pageEls[pageNum];
  const wrapRect = wrap.getBoundingClientRect();
  const rects = picked.map((s) => {
    const r = s.getBoundingClientRect();
    return {
      x: (r.left - wrapRect.left) / viewport.width,
      y: (r.top - wrapRect.top) / viewport.height,
      w: r.width / viewport.width,
      h: r.height / viewport.height
    };
  });
  return { pageNum, text, rects };
}

function onDragMove(e) {
  if (!activeDrag) return;
  e.preventDefault();
  const idx = spanIndexAtPoint(activeDrag.pageNum, e.clientX, e.clientY);
  if (idx === -1) return;
  activeDrag.currentIndex = idx;
  renderActiveDragPreview();
}

function onDragUp() { endDrag(true); }
function onDragCancel() { endDrag(false); }

function endDrag(commit) {
  if (!activeDrag) return;
  document.removeEventListener('pointermove', onDragMove);
  const finishedMode = mode;
  const picked = commit ? activeDragSelection() : null;
  clearActiveDragPreview();
  activeDrag = null;
  if (!picked) return;

  if (finishedMode === 'highlight') {
    saveHighlightFromSpans(picked);
  } else if (finishedMode === 'ai') {
    openAiPanel(picked.text);
  } else if (finishedMode === 'note' && typeof openNoteModalWithSelection === 'function') {
    openNoteModalWithSelection(picked.text, picked.pageNum);
  }
}

function wireSpanDrag(pageNum, textLayer) {
  textLayer.addEventListener('pointerdown', (e) => {
    if (mode !== 'highlight' && mode !== 'ai' && mode !== 'note') return;
    const idx = spanIndexAtPoint(pageNum, e.clientX, e.clientY);
    if (idx === -1) return;
    e.preventDefault();
    activeDrag = { pageNum, spans: textLayerSpans(pageNum), startIndex: idx, currentIndex: idx, previewEls: [] };
    renderActiveDragPreview();
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragUp, { once: true });
    document.addEventListener('pointercancel', onDragCancel, { once: true });
  });
}

async function saveHighlightFromSpans({ pageNum, text, rects }) {
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

/* ---------------- Current page, scroll tracking, jump, resume ---------------- */

let restoreDone = false;   // initial position restored (or nothing to restore)
let userScrolled = false;  // the reader moved on their own before restore finished
let pendingJump = null;    // page number requested before that page was rendered
let rafPending = false;

// The page that fills most of the visible reading area, plus how far down it the top edge of the
// view is (0..1). Based on real on-screen geometry, so it works for tall pages on short screens.
function measureCurrentPage() {
  const bodyRect = readerBody.getBoundingClientRect();
  let bestPage = null;
  let bestOverlap = -1;
  let offset = 0;
  for (const key of Object.keys(pageEls)) {
    const r = pageEls[key].wrap.getBoundingClientRect();
    const overlap = Math.min(r.bottom, bodyRect.bottom) - Math.max(r.top, bodyRect.top);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestPage = Number(key);
      offset = r.height ? Math.min(1, Math.max(0, (bodyRect.top - r.top) / r.height)) : 0;
    }
  }
  return bestPage ? { page: bestPage, offset } : null;
}

// Page to save / show. Until the saved position has been restored (or the reader scrolled), keep the
// saved page so that opening and quickly leaving a book never resets your progress to page 1.
function getCurrentPage() {
  if (!restoreDone && !userScrolled) return { page: book.lastPage || 1, offset: book.lastPageOffset || 0 };
  return measureCurrentPage() || { page: currentVisiblePage || 1, offset: 0 };
}

function updatePageIndicator() {
  const input = document.getElementById('pageInput');
  const total = document.getElementById('pageTotal');
  if (total && pdfDoc) total.textContent = `/ ${pdfDoc.numPages}`;
  if (input && document.activeElement !== input) input.value = currentVisiblePage;
}

function onScrollFrame() {
  rafPending = false;
  currentVisiblePage = getCurrentPage().page;
  updatePageIndicator();
  if (restoreDone || userScrolled) scheduleSaveProgress();
}

readerBody.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(onScrollFrame);
});
['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach((evt) =>
  readerBody.addEventListener(evt, () => { userScrolled = true; }, { passive: true })
);

function setupScrollTracking() {
  updatePageIndicator();
}

function progressPayload() {
  const { page, offset } = getCurrentPage();
  currentVisiblePage = page;
  return { lastPage: page, lastPageOffset: offset };
}

function scheduleSaveProgress() {
  clearTimeout(saveProgressTimer);
  saveProgressTimer = setTimeout(() => {
    fetch(`/api/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(progressPayload()),
      keepalive: true
    }).catch(() => {});
  }, 600);
}

// Save when the tab is hidden or closed, too.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && book && pdfDoc && (restoreDone || userScrolled)) {
    clearTimeout(saveProgressTimer);
    fetch(`/api/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(progressPayload()),
      keepalive: true
    }).catch(() => {});
  }
});

function scrollToPage(pageNum, offset = 0) {
  const target = pageEls[pageNum];
  if (!target) return false;
  const bodyRect = readerBody.getBoundingClientRect();
  const r = target.wrap.getBoundingClientRect();
  readerBody.scrollTop += (r.top - bodyRect.top) + offset * r.height;
  currentVisiblePage = pageNum;
  updatePageIndicator();
  return true;
}

function restoreScrollPosition() {
  const urlPage = Number(params.get('page'));
  const wanted = Number.isInteger(urlPage) && urlPage >= 1 ? urlPage : book.lastPage;
  const offset = wanted === book.lastPage && !params.get('page') ? (book.lastPageOffset || 0) : 0;
  if (!userScrolled || params.get('page')) scrollToPage(Math.min(wanted, pdfDoc.numPages), offset);
  restoreDone = true;
  currentVisiblePage = getCurrentPage().page;
  updatePageIndicator();
}

// Jump to a page number typed by the reader. Pages render top to bottom, so if the page is not
// rendered yet the jump is remembered and runs the moment that page appears.
function jumpToPage(raw) {
  const status = document.getElementById('jumpStatus');
  const total = pdfDoc ? pdfDoc.numPages : 0;
  const n = Math.floor(Number(raw));
  if (!total) return;
  if (!Number.isFinite(n) || n < 1 || n > total) {
    status.textContent = `Enter 1–${total}`;
    setTimeout(() => { status.textContent = ''; }, 2000);
    return;
  }
  userScrolled = true;
  if (scrollToPage(n)) {
    pendingJump = null;
    status.textContent = '';
    scheduleSaveProgress();
  } else {
    pendingJump = n;
    status.textContent = `Loading page ${n}…`;
  }
}

function wirePageJump() {
  const input = document.getElementById('pageInput');
  const go = document.getElementById('pageGo');
  if (!input || !go) return;
  go.addEventListener('click', () => jumpToPage(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { jumpToPage(input.value); input.blur(); }
  });
  input.addEventListener('focus', () => input.select());
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
  const body = progressPayload(); // measured from what is on screen right now
  const stoppedAt = body.lastPage;
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
