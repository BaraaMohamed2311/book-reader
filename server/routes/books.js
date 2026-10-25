const express = require('express');
const mongoose = require('mongoose');
const Book = require('../models/Book');
const Annotation = require('../models/Annotation');

const router = express.Router();

// Book files are stored in MongoDB Atlas via GridFS (bucket "bookfiles"), never on the server's disk.
// The browser sends the file in 2MB pieces so every request stays under Vercel's 4.5MB body limit;
// each piece is written straight into GridFS as chunk n of the file. The "books" document links to
// the file through book.fileId and carries all the metadata.
const BUCKET = 'bookfiles';
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_RANGE = 4 * 1024 * 1024; // never answer one Range request with more than 4MB

const PALETTE = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#D63031', '#00CEC9', '#FDCB6E'];
const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

const db = () => mongoose.connection.db;
const filesColl = () => db().collection(`${BUCKET}.files`);
const chunksColl = () => db().collection(`${BUCKET}.chunks`);
const bucket = () => new mongoose.mongo.GridFSBucket(db(), { bucketName: BUCKET });

let indexesReady = false;
async function ensureChunkIndex() {
  if (indexesReady) return;
  await chunksColl().createIndex({ files_id: 1, n: 1 }, { unique: true });
  indexesReady = true;
}

// Expected byte length of GridFS chunk `index` for a file of `size` bytes.
const chunkLen = (size, cs, index) => Math.min(cs, size - index * cs);


// Books uploaded by the previous version kept their bytes in a "bookchunks" collection (same 2MB
// chunk layout). Move them into GridFS inside Atlas and link them with book.fileId. Safe to run
// concurrently and to retry: the GridFS file id is the book's own id and every write is an upsert.
const migrating = new Map();
function migrateLegacy(book) {
  const key = String(book._id);
  if (!migrating.has(key)) {
    migrating.set(key, doMigrateLegacy(book).finally(() => migrating.delete(key)));
  }
  return migrating.get(key);
}

async function doMigrateLegacy(book) {
  if (book.fileId) return book;
  if (!book.chunkSize || !book.fileSize) return null;
  const legacy = db().collection('bookchunks');
  const expected = Math.ceil(book.fileSize / book.chunkSize);
  if ((await legacy.countDocuments({ bookId: book._id })) !== expected) return null;

  await ensureChunkIndex();
  const fileId = book._id;
  for await (const c of legacy.find({ bookId: book._id }).sort({ index: 1 })) {
    await chunksColl().updateOne({ files_id: fileId, n: c.index }, { $set: { data: c.data } }, { upsert: true });
  }
  if ((await chunksColl().countDocuments({ files_id: fileId })) !== expected) return null;

  await filesColl().updateOne(
    { _id: fileId },
    {
      $setOnInsert: {
        length: book.fileSize,
        chunkSize: book.chunkSize,
        uploadDate: new Date(),
        filename: book.originalName,
        contentType: MIME[book.fileType],
        metadata: { bookId: book._id, title: book.title, fileType: book.fileType, originalName: book.originalName }
      }
    },
    { upsert: true }
  );
  await Book.updateOne({ _id: book._id }, { $set: { fileId, mimeType: MIME[book.fileType], uploadComplete: true } });
  await legacy.deleteMany({ bookId: book._id }); // single copy of the file: GridFS only
  return Book.findById(book._id);
}

async function removeFile(book) {
  if (!book.fileId) return;
  await chunksColl().deleteMany({ files_id: book.fileId });
  await filesColl().deleteOne({ _id: book.fileId });
}

// List all (finished) books
router.get('/', async (req, res) => {
  try {
    const books = await Book.find({ uploadComplete: { $ne: false } }).sort({ lastReadAt: -1 });
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 1 of upload: create the book record (metadata) + its GridFS file entry
router.post('/', async (req, res) => {
  try {
    const { title, originalName, fileType, fileSize } = req.body;
    const size = Number(fileSize);
    if (!originalName || !['pdf', 'epub'].includes(fileType) || !size) {
      return res.status(400).json({ error: 'originalName, fileType (pdf|epub) and fileSize are required' });
    }
    if (size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File is larger than 200MB' });
    await ensureChunkIndex();

    const fileId = new mongoose.Types.ObjectId();
    const book = await Book.create({
      title: (title && title.trim()) || originalName.replace(/\.[^.]+$/, ''),
      originalName,
      fileType,
      fileSize: size,
      mimeType: MIME[fileType],
      fileId,
      chunkSize: CHUNK_SIZE,
      uploadComplete: false,
      coverColor: PALETTE[Math.floor(Math.random() * PALETTE.length)]
    });
    // GridFS file document (same layout GridFSBucket uses), linked back to the book.
    await filesColl().insertOne({
      _id: fileId,
      length: size,
      chunkSize: CHUNK_SIZE,
      uploadDate: new Date(),
      filename: originalName,
      contentType: MIME[fileType],
      metadata: { bookId: book._id, title: book.title, fileType, originalName }
    });
    res.status(201).json({ ...book.toObject(), chunkSize: CHUNK_SIZE });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: upload one raw chunk (body = bytes) into GridFS. Safe to retry.
router.put('/:id/chunks/:index', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
  try {
    const index = Number(req.params.index);
    const book = await Book.findById(req.params.id);
    if (!book || book.uploadComplete || !book.fileId) return res.status(404).json({ error: 'Upload not found' });
    const expected = Math.ceil(book.fileSize / book.chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= expected) {
      return res.status(400).json({ error: 'Bad chunk index' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length !== chunkLen(book.fileSize, book.chunkSize, index)) {
      return res.status(400).json({ error: 'Chunk has the wrong size' });
    }
    await ensureChunkIndex();
    await chunksColl().updateOne(
      { files_id: book.fileId, n: index },
      { $set: { data: req.body } },
      { upsert: true }
    );
    res.json({ ok: true, index });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3: verify the whole file is in Atlas, then publish the book
router.post('/:id/complete', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const expected = Math.ceil(book.fileSize / book.chunkSize);
    const stored = await chunksColl().countDocuments({ files_id: book.fileId });
    if (stored !== expected) {
      return res.status(400).json({ error: `Upload incomplete (${stored}/${expected} chunks)` });
    }
    book.uploadComplete = true;
    await book.save();
    res.json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move every book uploaded by the previous version into GridFS (also happens automatically on open).
router.post('/migrate-legacy', async (req, res) => {
  try {
    const todo = await Book.find({ fileId: null, chunkSize: { $gt: 0 } });
    let migrated = 0;
    for (const b of todo) {
      if (await migrateLegacy(b)) migrated++;
    }
    res.json({ migrated, remaining: todo.length - migrated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single book
router.get('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    res.json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream the book file out of GridFS with HTTP Range support (PDF.js loads big PDFs piecewise,
// and each response stays small enough for Vercel).
router.get('/:id/file', async (req, res) => {
  try {
    let book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (!book.fileId) {
      // Uploaded by the previous version: move it into GridFS now (inside Atlas), then serve it.
      book = await migrateLegacy(book);
      if (!book) {
        return res.status(404).json({
          error: 'The file for this book is not in MongoDB (its upload never finished, or it was saved on a server disk that no longer exists). Delete it and upload it again.'
        });
      }
    }
    const stored = await chunksColl().countDocuments({ files_id: book.fileId });
    if (stored !== Math.ceil(book.fileSize / book.chunkSize)) {
      return res.status(404).json({ error: "This book's file is incomplete in the database. Delete it and upload it again." });
    }

    const total = book.fileSize;
    let start = 0;
    let end = total - 1;
    let partial = false;

    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      partial = true;
      if (m[1] === '') {
        start = Math.max(0, total - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
      }
      end = Math.min(end, start + MAX_RANGE - 1);
      if (start >= total || start > end) {
        res.set('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
    }

    res.set({
      'Content-Type': MIME[book.fileType] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Length': end - start + 1
    });
    if (partial) {
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`);
    }

    // GridFS "end" is exclusive.
    const stream = bucket().openDownloadStream(book.fileId, { start, end: end + 1 });
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy(err);
    });
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  }
});

// Update reading progress (page + scroll ratio) and total page count
router.put('/:id/progress', async (req, res) => {
  try {
    const { lastPage, lastScrollRatio, lastPageOffset, totalPages } = req.body;
    const update = { lastReadAt: new Date() };
    if (lastPage !== undefined) update.lastPage = lastPage;
    if (lastScrollRatio !== undefined) update.lastScrollRatio = lastScrollRatio;
    if (lastPageOffset !== undefined) update.lastPageOffset = Math.min(1, Math.max(0, Number(lastPageOffset) || 0));
    if (totalPages !== undefined) update.totalPages = totalPages;

    const book = await Book.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!book) return res.status(404).json({ error: 'Book not found' });
    res.json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a book + its GridFS file + its annotations
router.delete('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    await removeFile(book);
    await Annotation.deleteMany({ bookId: book._id });
    await book.deleteOne();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
