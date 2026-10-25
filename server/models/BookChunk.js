const mongoose = require('mongoose');

// A book file is stored in MongoDB as fixed-size chunks (each well under the 16MB doc limit
// and under Vercel's 4.5MB request limit). Chunk i holds bytes [i*chunkSize, (i+1)*chunkSize).
const BookChunkSchema = new mongoose.Schema(
  {
    bookId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    index: { type: Number, required: true },
    data: { type: Buffer, required: true }
  },
  { versionKey: false }
);
BookChunkSchema.index({ bookId: 1, index: 1 }, { unique: true });

module.exports = mongoose.model('BookChunk', BookChunkSchema);
