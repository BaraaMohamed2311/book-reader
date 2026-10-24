const mongoose = require('mongoose');

/*
  Two kinds of annotations:
  - "highlight": a text highlight, stored as the rectangles PDF.js reports
    for a text selection on a given page (so it can be redrawn at any zoom).
  - "drawing": a freehand ink stroke, stored as an array of {x,y} points
    in PDF-space ratio coordinates (0..1) so it scales with the page.
*/
const AnnotationSchema = new mongoose.Schema(
  {
    bookId: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true, index: true },
    page: { type: Number, required: true },
    type: { type: String, enum: ['highlight', 'drawing'], required: true },
    color: { type: String, default: '#FFE066' },
    // highlight: list of rects {x,y,w,h} in ratio coords (0..1 of page width/height)
    rects: { type: Array, default: [] },
    // drawing: list of points {x,y} in ratio coords, plus stroke width
    points: { type: Array, default: [] },
    strokeWidth: { type: Number, default: 3 },
    text: { type: String, default: '' }, // the highlighted text snippet, if any
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

module.exports = mongoose.model('Annotation', AnnotationSchema);
