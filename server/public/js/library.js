const bookGrid = document.getElementById('bookGrid');
const emptyState = document.getElementById('emptyState');
const uploadOverlay = document.getElementById('uploadOverlay');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileChosenLabel = document.getElementById('fileChosenLabel');
const titleInput = document.getElementById('titleInput');

let selectedFile = null;

// Books uploaded by the previous version are moved into GridFS inside Atlas (server-side, once).
let legacyMigrationStarted = false;
function migrateLegacyBooks() {
  if (legacyMigrationStarted) return;
  legacyMigrationStarted = true;
  fetch('/api/books/migrate-legacy', { method: 'POST' }).catch(() => {});
}

async function loadBooks() {
  const res = await fetch('/api/books', { cache: 'no-store' });
  const books = await res.json();
  renderBooks(books);
  migrateLegacyBooks();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderBooks(books) {
  bookGrid.innerHTML = '';
  if (!books.length) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  books.forEach((book) => {
    const progress = book.totalPages ? Math.min(100, Math.round((book.lastPage / book.totalPages) * 100)) : 0;
    const card = document.createElement('div');
    card.className = 'book-card';
    card.innerHTML = `
      <div class="book-cover" style="background:${book.coverColor};">
        <div>
          <div class="cover-icon">${book.fileType}</div>
          <div class="cover-title">${escapeHtml(book.title)}</div>
        </div>
      </div>
      <div class="book-info">
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-progress-track"><div class="book-progress-fill" style="width:${progress}%;"></div></div>
        <div class="book-meta">${book.totalPages ? `Page ${book.lastPage} of ${book.totalPages}` : 'Not started yet'}</div>
      </div>
      <button class="book-delete" title="Delete">✕</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.book-delete')) return;
      window.location.href = `/reader.html?id=${book._id}`;
    });
    card.querySelector('.book-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${book.title}"? This also removes its highlights and drawings.`)) return;
      await fetch(`/api/books/${book._id}`, { method: 'DELETE' });
      loadBooks();
    });
    bookGrid.appendChild(card);
  });
}

// ---- Upload modal wiring ----
document.getElementById('openUploadBtn').addEventListener('click', () => {
  uploadOverlay.style.display = 'flex';
});
document.getElementById('cancelUploadBtn').addEventListener('click', closeUpload);
uploadOverlay.addEventListener('click', (e) => { if (e.target === uploadOverlay) closeUpload(); });

function closeUpload() {
  uploadOverlay.style.display = 'none';
  selectedFile = null;
  fileInput.value = '';
  fileChosenLabel.textContent = '';
  titleInput.value = '';
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setSelectedFile(fileInput.files[0]);
});
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag'); })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

function setSelectedFile(file) {
  selectedFile = file;
  fileChosenLabel.textContent = file.name;
  if (!titleInput.value) {
    titleInput.value = file.name.replace(/\.[^.]+$/, '');
  }
}

document.getElementById('confirmUploadBtn').addEventListener('click', async () => {
  if (!selectedFile) {
    alert('Please choose a PDF or EPUB file first.');
    return;
  }
  const btn = document.getElementById('confirmUploadBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';

  try {
    const ext = selectedFile.name.split('.').pop().toLowerCase();
    // 1) create the record
    let res = await fetch('/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: titleInput.value,
        originalName: selectedFile.name,
        fileType: ext,
        fileSize: selectedFile.size
      })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
    const created = await res.json();

    try {
      // 2) send the file to MongoDB (via the API) in small pieces
      const cs = created.chunkSize;
      const count = Math.ceil(selectedFile.size / cs);
      for (let i = 0; i < count; i++) {
        const piece = selectedFile.slice(i * cs, (i + 1) * cs);
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const r = await fetch(`/api/books/${created._id}/chunks/${i}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: piece
          });
          ok = r.ok;
          if (!ok && attempt === 2) throw new Error((await r.json().catch(() => ({}))).error || 'Chunk upload failed');
        }
        btn.textContent = `Uploading… ${Math.round(((i + 1) / count) * 100)}%`;
      }
      // 3) finish
      res = await fetch(`/api/books/${created._id}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
    } catch (err) {
      fetch(`/api/books/${created._id}`, { method: 'DELETE' }).catch(() => {});
      throw err;
    }
    const book = created;
    closeUpload();
    window.location.href = `/reader.html?id=${book._id}`;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload';
  }
});

loadBooks();

// Refresh progress bars when returning via the browser back button (bfcache)
window.addEventListener('pageshow', (e) => { if (e.persisted) loadBooks(); });
