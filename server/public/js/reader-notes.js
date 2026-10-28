// Saving words/phrases and quotes from inside the reader. Uses globals from reader.js
// (bookId, pendingSelectionRange, currentSelectionText, clearPendingSelection, getCurrentPage).

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', Boolean(isError));
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

const ENDPOINT = { word: '/api/vocab', quote: '/api/quotes' };
const LABEL = { word: 'Words', quote: 'Quotes' };

async function saveEntry(kind, fields) {
  const res = await fetch(ENDPOINT[kind], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId, ...fields })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not save');
  return data;
}

// Manual add modal (paste or type) — also how a selection gets saved as a
// word or quote now: tap 📝 Note in the top toolbar with text selected, the
// selection is prefilled, review/add an explanation, then save.
const noteOverlay = document.getElementById('noteOverlay');
const noteText = document.getElementById('noteText');
const noteExplanation = document.getElementById('noteExplanation');
const noteAuthor = document.getElementById('noteAuthor');
const notePage = document.getElementById('notePage');
let noteKind = 'word';

function setNoteKind(kind) {
  noteKind = kind;
  document.querySelectorAll('#noteKind .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  document.getElementById('noteAuthorField').style.display = kind === 'quote' ? 'block' : 'none';
}
document.querySelectorAll('#noteKind .seg-btn').forEach((b) => b.addEventListener('click', () => setNoteKind(b.dataset.kind)));

function openNoteModal() {
  const selected = (typeof currentSelectionText === 'function' ? currentSelectionText() : '').replace(/\s+/g, ' ').trim();
  noteText.value = selected;
  noteExplanation.value = '';
  noteAuthor.value = '';
  notePage.value = (pendingSelectionRange && pendingSelectionRange.pageNum)
    || (typeof getCurrentPage === 'function' ? getCurrentPage().page : '');
  setNoteKind(noteKind);
  noteOverlay.style.display = 'flex';
  noteText.focus();
}
function closeNoteModal() {
  noteOverlay.style.display = 'none';
  if (typeof clearPendingSelection === 'function') clearPendingSelection();
}

document.getElementById('toolNote').addEventListener('click', openNoteModal);
document.getElementById('noteCancel').addEventListener('click', closeNoteModal);
noteOverlay.addEventListener('click', (e) => { if (e.target === noteOverlay) closeNoteModal(); });

document.getElementById('noteSave').addEventListener('click', async () => {
  const text = noteText.value.replace(/\s+/g, ' ').trim();
  if (!text) { noteText.focus(); return; }
  const btn = document.getElementById('noteSave');
  btn.disabled = true;
  try {
    const fields = { text, explanation: noteExplanation.value.trim(), page: Number(notePage.value) || 0 };
    if (noteKind === 'quote') fields.author = noteAuthor.value.trim();
    await saveEntry(noteKind, fields);
    closeNoteModal();
    toast(`Saved to ${LABEL[noteKind]}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
