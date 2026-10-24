const express = require('express');
const Annotation = require('../models/Annotation');

const router = express.Router();

// Get all annotations for a book (optionally filtered by page)
router.get('/book/:bookId', async (req, res) => {
  try {
    const query = { bookId: req.params.bookId };
    if (req.query.page) query.page = Number(req.query.page);
    const annotations = await Annotation.find(query).sort({ createdAt: 1 });
    res.json(annotations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new annotation (highlight or drawing)
router.post('/', async (req, res) => {
  try {
    const { bookId, page, type, color, rects, points, strokeWidth, text } = req.body;
    if (!bookId || !page || !type) {
      return res.status(400).json({ error: 'bookId, page and type are required' });
    }
    const annotation = await Annotation.create({
      bookId, page, type, color, rects, points, strokeWidth, text
    });
    res.status(201).json(annotation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a single annotation (e.g. eraser / undo)
router.delete('/:id', async (req, res) => {
  try {
    await Annotation.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all annotations on a page (optional utility)
router.delete('/book/:bookId/page/:page', async (req, res) => {
  try {
    await Annotation.deleteMany({ bookId: req.params.bookId, page: Number(req.params.page) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
