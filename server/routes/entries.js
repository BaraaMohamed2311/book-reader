const express = require('express');
const mongoose = require('mongoose');
const Book = require('../models/Book');

// Shared CRUD router for saved entries (words/phrases and quotes).
// `extraFields` lists the model fields beyond the common ones that clients may set.
module.exports = function makeEntriesRouter(Model, extraFields = []) {
  const router = express.Router();
  const editable = ['text', 'explanation', ...extraFields];

  const pick = (body) => {
    const out = {};
    editable.forEach((k) => { if (body[k] !== undefined) out[k] = String(body[k]); });
    return out;
  };

  // List (newest first). Optional ?bookId=...  ?q=search text
  router.get('/', async (req, res) => {
    try {
      const query = {};
      if (req.query.bookId && mongoose.isValidObjectId(req.query.bookId)) query.bookId = req.query.bookId;
      if (req.query.q) {
        const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [{ text: rx }, { explanation: rx }, ...extraFields.map((f) => ({ [f]: rx }))];
      }
      res.json(await Model.find(query).sort({ createdAt: -1 }).limit(1000));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const data = pick(req.body);
      data.text = (data.text || '').replace(/\s+/g, ' ').trim();
      if (!data.text) return res.status(400).json({ error: 'text is required' });
      if (data.text.length > 5000) return res.status(400).json({ error: 'text is too long (max 5000 characters)' });

      const { bookId, page } = req.body;
      if (bookId && mongoose.isValidObjectId(bookId)) {
        const book = await Book.findById(bookId).select('title');
        if (book) { data.bookId = book._id; data.bookTitle = book.title; }
      }
      if (page !== undefined && Number.isFinite(Number(page))) data.page = Math.max(0, Math.floor(Number(page)));
      res.status(201).json(await Model.create(data));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const data = pick(req.body);
      if (data.text !== undefined) {
        data.text = data.text.replace(/\s+/g, ' ').trim();
        if (!data.text) return res.status(400).json({ error: 'text cannot be empty' });
      }
      const doc = await Model.findByIdAndUpdate(req.params.id, data, { new: true });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
