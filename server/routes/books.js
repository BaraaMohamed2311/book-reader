const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Book = require('../models/Book');
const Annotation = require('../models/Annotation');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) { /* read-only FS on Vercel — fine, blob is used instead */ }
}

// On Vercel the filesystem is read-only/ephemeral, so uploaded files are stored
// in Vercel Blob instead. Locally (no BLOB_READ_WRITE_TOKEN) they're kept on disk.
const USE_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const PALETTE = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#D63031', '#00CEC9', '#FDCB6E'];

// Always buffer in memory first — we decide where the bytes end up (disk vs blob) after.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.epub') cb(null, true);
    else cb(new Error('Only .pdf and .epub files are supported'));
  }
});

// List all books
router.get('/', async (req, res) => {
  try {
    const books = await Book.find().sort({ lastReadAt: -1 });
    res.json(books);
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

// Upload a new book
router.post('/upload', upload.single('book'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const title = (req.body.title && req.body.title.trim()) || path.basename(req.file.originalname, path.extname(req.file.originalname));
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;

    let fileName = '';
    let fileUrl = '';

    if (USE_BLOB) {
      const { put } = require('@vercel/blob');
      const blob = await put(unique, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype || 'application/octet-stream'
      });
      fileUrl = blob.url;
    } else {
      fs.writeFileSync(path.join(UPLOAD_DIR, unique), req.file.buffer);
      fileName = unique;
    }

    const book = await Book.create({
      title,
      fileName,
      fileUrl,
      originalName: req.file.originalname,
      fileType: ext,
      fileSize: req.file.size,
      coverColor: color
    });

    res.status(201).json(book);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream the raw book file (used by PDF.js / epub.js on both pc and phone)
router.get('/:id/file', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    if (book.fileUrl) {
      return res.redirect(book.fileUrl);
    }

    const filePath = path.join(UPLOAD_DIR, book.fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Delete a book + its file + its annotations
router.delete('/:id', async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });

    if (book.fileUrl && USE_BLOB) {
      try {
        const { del } = require('@vercel/blob');
        await del(book.fileUrl);
      } catch (_) { /* best effort */ }
    } else if (book.fileName) {
      const filePath = path.join(UPLOAD_DIR, book.fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await Annotation.deleteMany({ bookId: book._id });
    await book.deleteOne();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
