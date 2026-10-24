const mongoose = require('mongoose');

const BookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    fileName: { type: String, required: true }, // stored file name on disk
    originalName: { type: String, required: true },
    fileType: { type: String, enum: ['pdf', 'epub'], required: true },
    fileSize: { type: Number, default: 0 },
    coverColor: { type: String, default: '#6C5CE7' }, // used for generated cover
    totalPages: { type: Number, default: 0 },
    lastPage: { type: Number, default: 1 }, // resume position
    lastScrollRatio: { type: Number, default: 0 }, // fine-grained scroll offset within page
    lastReadAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

module.exports = mongoose.model('Book', BookSchema);
