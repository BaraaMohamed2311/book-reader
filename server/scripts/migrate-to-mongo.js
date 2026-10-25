// Run LOCALLY once: moves old books into MongoDB GridFS and links them via book.fileId.
// Handles two kinds of old books:
//   1. files saved on disk in server/uploads (book.fileName)
//   2. files stored in the old "bookchunks" collection
// Needs MONGO_URI in server/.env (same Atlas DB as Vercel).   cd server && npm run migrate-mongo
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Book = require('../models/Book');

const BUCKET = 'bookfiles';
const CHUNK_SIZE = 2 * 1024 * 1024;
const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

async function store(db, book, buf) {
  const files = db.collection(`${BUCKET}.files`);
  const chunks = db.collection(`${BUCKET}.chunks`);
  await chunks.createIndex({ files_id: 1, n: 1 }, { unique: true });
  const fileId = new mongoose.Types.ObjectId();
  for (let n = 0; n * CHUNK_SIZE < buf.length; n++) {
    await chunks.insertOne({ files_id: fileId, n, data: buf.subarray(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE) });
  }
  await files.insertOne({
    _id: fileId, length: buf.length, chunkSize: CHUNK_SIZE, uploadDate: new Date(),
    filename: book.originalName, contentType: MIME[book.fileType],
    metadata: { bookId: book._id, title: book.title, fileType: book.fileType, originalName: book.originalName }
  });
  book.fileId = fileId;
  book.fileSize = buf.length;
  book.chunkSize = CHUNK_SIZE;
  book.mimeType = MIME[book.fileType];
  book.uploadComplete = true;
  await book.save();
}

(async () => {
  if (!process.env.MONGO_URI) { console.error('Set MONGO_URI in server/.env first.'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const books = await Book.find({ fileId: null });
  console.log(`${books.length} book(s) without a GridFS file`);
  for (const book of books) {
    let buf = null;
    const diskPath = book.fileName ? path.join(__dirname, '..', 'uploads', book.fileName) : '';
    if (diskPath && fs.existsSync(diskPath)) {
      buf = fs.readFileSync(diskPath);
    } else {
      const old = await db.collection('bookchunks').find({ bookId: book._id }).sort({ index: 1 }).toArray();
      if (old.length) buf = Buffer.concat(old.map((c) => c.data.buffer ? Buffer.from(c.data.buffer) : Buffer.from(c.data)));
    }
    if (!buf) { console.log(`skip "${book.title}": no file found (re-upload it)`); continue; }
    await store(db, book, buf);
    await db.collection('bookchunks').deleteMany({ bookId: book._id });
    console.log(`migrated "${book.title}" (${buf.length} bytes)`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
