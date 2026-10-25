const mongoose = require('mongoose');

// A saved quote from a book, with the reader's own note. Collection: "quotes".
const QuoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    explanation: { type: String, default: '' }, // the reader's note / why it matters
    author: { type: String, default: '', trim: true },
    bookId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    bookTitle: { type: String, default: '' },
    page: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

module.exports = mongoose.model('Quote', QuoteSchema);
