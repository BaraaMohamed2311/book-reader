// Saving words/phrases and quotes from inside the reader. Uses globals from reader.js
// (bookId). The modal is opened by reader.js, via openNoteModalWithSelection, once the
// reader has dragged over some text while the 📝 Note tool is armed.

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

// Modal to review/edit a dragged-over passage before saving it as a word or
// quote (reader.js calls openNoteModalWithSelection once a drag over text
// finishes while the Note tool is armed).
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

function openNoteModalWithSelection(text, page) {
  noteText.value = (text || '').replace(/\s+/g, ' ').trim();
  noteExplanation.value = '';
  noteAuthor.value = '';
  notePage.value = page || (typeof getCurrentPage === 'function' ? getCurrentPage().page : '');
  setNoteKind(noteKind);
  noteOverlay.style.display = 'flex';
  noteText.focus();
}
function closeNoteModal() {
  noteOverlay.style.display = 'none';
}

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
