// Run LOCALLY once: moves books that were saved on disk (server/uploads) into MongoDB,
// so they open from the Vercel app. Needs MONGO_URI in server/.env (same Atlas DB as Vercel).
//   cd server && npm run migrate-mongo
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Book = require('../models/Book');
const BookChunk = require('../models/BookChunk');

const CHUNK_SIZE = 2 * 1024 * 1024;

(async () => {
  if (!process.env.MONGO_URI) { console.error('Set MONGO_URI in server/.env first.'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI);
  const books = await Book.find({ chunkSize: { $in: [0, null] }, fileName: { $ne: '' } });
  console.log(`${books.length} disk book(s) to migrate`);
  for (const book of books) {
    const filePath = path.join(__dirname, '..', 'uploads', book.fileName);
    if (!fs.existsSync(filePath)) { console.log(`skip "${book.title}": ${book.fileName} not on disk`); continue; }
    const buf = fs.readFileSync(filePath);
    await BookChunk.deleteMany({ bookId: book._id });
    for (let i = 0; i * CHUNK_SIZE < buf.length; i++) {
      await BookChunk.create({ bookId: book._id, index: i, data: buf.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
    }
    book.fileSize = buf.length;
    book.chunkSize = CHUNK_SIZE;
    book.uploadComplete = true;
    await book.save();
    console.log(`migrated "${book.title}" (${buf.length} bytes)`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
