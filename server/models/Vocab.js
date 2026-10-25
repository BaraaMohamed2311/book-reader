const mongoose = require('mongoose');

// A saved word / phrase from a book, with the reader's own explanation. Collection: "vocabs".
const VocabSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    explanation: { type: String, default: '' },
    bookId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    bookTitle: { type: String, default: '' }, // snapshot, so the entry survives deleting the book
    page: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

module.exports = mongoose.model('Vocab', VocabSchema);
