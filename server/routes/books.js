const express = require('express');
const path = require('path');
const fs = require('fs');
const Book = require('../models/Book');
const BookChunk = require('../models/BookChunk');
const Annotation = require('../models/Annotation');

const router = express.Router();

// Book files live in MongoDB (collection "bookchunks"). The browser uploads them in pieces so
// every request stays under Vercel's 4.5MB body limit.
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_RANGE = 4 * 1024 * 1024; // never answer a single Range request with more than 4MB
const LEGACY_UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const PALETTE = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#D63031', '#00CEC9', '#FDCB6E'];
const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

// List all (finished) books
router.get('/', async (req, res) => {
  try {
    const books = await Book.find({ uploadComplete: { $ne: false } }).sort({ lastReadAt: -1 });
    res.json(books);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 1 of upload: create the book record
router.post('/', async (req, res) => {
  try {
    const { title, originalName, fileType, fileSize } = req.body;
    const size = Number(fileSize);
    if (!originalName || !['pdf', 'epub'].includes(fileType) || !size) {
      return res.status(400).json({ error: 'originalName, fileType (pdf|epub) and fileSize are required' });
    }
    if (size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File is larger than 200MB' });
    const book = await Book.create({
      title: (title && title.trim()) || originalName.replace(/\.[^.]+$/, ''),
      originalName,
      fileType,
      fileSize: size,
      chunkSize: CHUNK_SIZE,
      uploadComplete: false,
      coverColor: PALETTE[Math.floor(Math.random() * PALETTE.length)]
    });
    res.status(201).json({ ...book.toObject(), chunkSize: CHUNK_SIZE });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: upload one raw chunk (body = bytes). Safe to retry.
router.put('/:id/chunks/:index', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
  try {
    const index = Number(req.params.index);
    const book = await Book.findById(req.params.id);
    if (!book || book.uploadComplete) return res.status(404).json({ error: 'Upload not found' });
    const expected = Math.ceil(book.fileSize / book.chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= expected) {
      return res.status(400).json({ error: 'Bad chunk index' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Empty chunk' });
    }
    await BookChunk.updateOne({ bookId: book._id, index }, { $set: { data: req.body } }, { upsert: true });
    res.json({ ok: true, index });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3: verify all chunks arrived and publish the book
router.post('/:id/complete', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const expected = Math.ceil(book.fileSize / book.chunkSize);
    const stored = await BookChunk.countDocuments({ bookId: book._id });
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

// Serve the book file from MongoDB, with HTTP Range support (PDF.js loads big PDFs piecewise,
// and each response stays small enough for Vercel).
router.get('/:id/file', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    // Legacy books uploaded to local disk before files moved to MongoDB.
    if (!book.chunkSize) {
      const filePath = book.fileName ? path.join(LEGACY_UPLOAD_DIR, book.fileName) : '';
      if (filePath && fs.existsSync(filePath)) return res.sendFile(filePath);
      return res.status(404).json({
        error: 'This book was saved on the old disk storage and its file no longer exists on the server. Delete it and re-upload it (or run "npm run migrate-mongo" locally if you still have server/uploads).'
      });
    }

    // Upload never finished, or chunks are gone: tell the user plainly instead of a broken viewer.
    const storedChunks = await BookChunk.countDocuments({ bookId: book._id });
    if (storedChunks !== Math.ceil(book.fileSize / book.chunkSize)) {
      return res.status(404).json({
        error: 'This book\'s file is incomplete in the database. Delete it and upload it again.'
      });
    }

    const total = book.fileSize;
    const cs = book.chunkSize;
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
      'Cache-Control': 'private, max-age=3600'
    });

    if (partial) {
      const first = Math.floor(start / cs);
      const last = Math.floor(end / cs);
      const chunks = await BookChunk.find({ bookId: book._id, index: { $gte: first, $lte: last } }).sort({ index: 1 });
      const buf = Buffer.concat(chunks.map((c) => c.data));
      const offset = start - first * cs;
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1
      });
      return res.end(buf.subarray(offset, offset + (end - start + 1)));
    }

    // No Range header: stream every chunk in order.
    res.status(200).set('Content-Length', total);
    const count = Math.ceil(total / cs);
    for (let i = 0; i < count; i++) {
      const c = await BookChunk.findOne({ bookId: book._id, index: i });
      if (!c) { res.destroy(new Error('missing chunk')); return; }
      res.write(c.data);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  }
});

// Update reading progress (page + scroll ratio) and total page count
router.put('/:id/progress', async (req, res) => {
  try {
    const { lastPage, lastScrollRatio, totalPages } = req.body;
    const update = { lastReadAt: new Date() };
    if (lastPage !== undefined) update.lastPage = lastPage;
    if (lastScrollRatio !== undefined) update.lastScrollRatio = lastScrollRatio;
    if (totalPages !== undefined) update.totalPages = totalPages;

    const book = await Book.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!book) return res.status(404).json({ error: 'Book not found' });
    res.json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a book + its file chunks + its annotations
router.delete('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    await BookChunk.deleteMany({ bookId: book._id });
    await Annotation.deleteMany({ bookId: book._id });
    await book.deleteOne();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
