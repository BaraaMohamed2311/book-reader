const mongoose = require('mongoose');

// One document per book in the "books" collection. The file itself lives in MongoDB GridFS
// (bucket "bookfiles": collections bookfiles.files + bookfiles.chunks) and is linked here by fileId.
const BookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    originalName: { type: String, required: true },
    fileType: { type: String, enum: ['pdf', 'epub'], required: true },
    fileSize: { type: Number, default: 0 },
    mimeType: { type: String, default: '' },
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true }, // -> bookfiles.files._id
    chunkSize: { type: Number, default: 0 }, // GridFS chunk size in bytes
    uploadComplete: { type: Boolean, default: true }, // false while the file is still uploading
    fileName: { type: String, default: '' }, // legacy (old local-disk uploads), only used by migrate script
    coverColor: { type: String, default: '#6C5CE7' },
    totalPages: { type: Number, default: 0 },
    lastPage: { type: Number, default: 1 },
    lastScrollRatio: { type: Number, default: 0 },
    lastPageOffset: { type: Number, default: 0 }, // how far down the last page you were (0..1)
    lastReadAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

module.exports = mongoose.model('Book', BookSchema);
