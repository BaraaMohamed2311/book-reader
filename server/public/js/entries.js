// Generic list page for saved words/phrases (/api/vocab) and quotes (/api/quotes).
const API = document.body.dataset.api;
const KIND = document.body.dataset.kind; // 'word' | 'quote'
const HAS_AUTHOR = document.body.dataset.author === '1';

const listEl = document.getElementById('entryList');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const bookFilter = document.getElementById('bookFilter');
const toastEl = document.getElementById('toast');

let entries = [];
let toastTimer = null;

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', Boolean(isError));
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function load() {
  try {
    const [list, books] = await Promise.all([api(API, { cache: 'no-store' }), api('/api/books', { cache: 'no-store' })]);
    entries = list;
    const current = bookFilter.value;
    bookFilter.innerHTML = '<option value="">All books</option>';
    const seen = new Map();
    entries.forEach((e) => { if (e.bookId) seen.set(e.bookId, e.bookTitle || 'Untitled book'); });
    books.forEach((b) => seen.set(b._id, b.title));
    seen.forEach((title, id) => {
      const o = document.createElement('option');
      o.value = id; o.textContent = title;
      bookFilter.appendChild(o);
    });
    bookFilter.value = current;
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function matches(e) {
  if (bookFilter.value && e.bookId !== bookFilter.value) return false;
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return true;
  return [e.text, e.explanation, e.author, e.bookTitle].some((v) => (v || '').toLowerCase().includes(q));
}

function render() {
  listEl.innerHTML = '';
  const shown = entries.filter(matches);
  emptyState.style.display = entries.length ? 'none' : 'block';
  shown.forEach((e) => listEl.appendChild(card(e)));
}

function card(e) {
  const el = document.createElement('div');
  el.className = 'entry-card ' + KIND;

  const text = document.createElement('div');
  text.className = 'entry-text';
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.textContent = e.text;
  el.appendChild(text);

  if (HAS_AUTHOR) {
    const author = document.createElement('input');
    author.type = 'text';
    author.className = 'entry-author';
    author.placeholder = 'Author';
    author.value = e.author || '';
    author.addEventListener('change', () => save(e, { author: author.value.trim() }));
    el.appendChild(author);
  }

  const expl = document.createElement('textarea');
  expl.className = 'entry-expl';
  expl.rows = 2;
  expl.placeholder = KIND === 'quote' ? 'Add your note…' : 'Add an explanation…';
  expl.value = e.explanation || '';
  const fit = () => { expl.style.height = 'auto'; expl.style.height = Math.max(54, expl.scrollHeight) + 'px'; };
  expl.addEventListener('input', fit);
  expl.addEventListener('blur', () => save(e, { explanation: expl.value }));
  el.appendChild(expl);
  setTimeout(fit, 0);

  text.addEventListener('blur', () => {
    const v = text.textContent.replace(/\s+/g, ' ').trim();
    if (!v) { text.textContent = e.text; return; }
    save(e, { text: v });
  });

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const src = document.createElement(e.bookId ? 'a' : 'span');
  if (e.bookId) src.href = `/reader.html?id=${e.bookId}${e.page ? `&page=${e.page}` : ''}`;
  src.textContent = (e.bookTitle || 'Added manually') + (e.page ? ` · p. ${e.page}` : '');
  meta.appendChild(src);
  const date = document.createElement('span');
  date.textContent = new Date(e.createdAt).toLocaleDateString();
  meta.appendChild(date);
  const del = document.createElement('button');
  del.className = 'entry-delete';
  del.title = 'Delete';
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    if (!confirm('Delete this entry?')) return;
    try {
      await api(`${API}/${e._id}`, { method: 'DELETE' });
      entries = entries.filter((x) => x._id !== e._id);
      render();
    } catch (err) { toast(err.message, true); }
  });
  meta.appendChild(del);
  el.appendChild(meta);
  return el;
}

async function save(entry, patch) {
  const changed = Object.keys(patch).some((k) => (entry[k] || '') !== patch[k]);
  if (!changed) return;
  try {
    const updated = await api(`${API}/${entry._id}`, json('PUT', patch));
    Object.assign(entry, updated);
    toast('Saved');
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('addBtn').addEventListener('click', async () => {
  const text = document.getElementById('addText').value.trim();
  if (!text) return;
  const body = { text, explanation: document.getElementById('addExplanation').value.trim() };
  if (HAS_AUTHOR) body.author = document.getElementById('addAuthor').value.trim();
  try {
    const created = await api(API, json('POST', body));
    entries.unshift(created);
    ['addText', 'addExplanation', 'addAuthor'].forEach((id) => { const f = document.getElementById(id); if (f) f.value = ''; });
    render();
  } catch (err) { toast(err.message, true); }
});

searchInput.addEventListener('input', render);
bookFilter.addEventListener('change', render);
load();
