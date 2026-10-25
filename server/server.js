require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// Fix for environments whose default DNS resolver can't resolve Mongo Atlas
// SRV records (ETIMEOUT / querySrv errors) — point Node's resolver at public DNS.
// Local-only: Vercel's network resolves Atlas fine, so don't touch DNS there.
if (!process.env.VERCEL) {
  const dns = require('node:dns/promises');
  dns.setServers(['1.1.1.1', '1.0.0.1']);
}

const booksRouter = require('./routes/books');
const annotationsRouter = require('./routes/annotations');
const aiRouter = require('./routes/ai');
const makeEntriesRouter = require('./routes/entries');
const Vocab = require('./models/Vocab');
const Quote = require('./models/Quote');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve the frontend
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

const IS_SERVERLESS = Boolean(process.env.VERCEL);
const MONGO_URI = process.env.MONGO_URI || (IS_SERVERLESS ? '' : 'mongodb://127.0.0.1:27017/book_reader');

// On Vercel, each invocation can reuse a warm Node process, so we cache the
// connection promise instead of calling mongoose.connect() on every request.
let mongoReady = null;
function ensureMongo() {
  if (!MONGO_URI) {
    return Promise.reject(new Error('MONGO_URI env var is not set in Vercel project settings'));
  }
  if (!mongoReady) {
    mongoReady = mongoose
      .connect(MONGO_URI, { serverSelectionTimeoutMS: 8000, bufferCommands: false })
      .then(() => console.log('Connected to MongoDB'))
      .catch((err) => {
        mongoReady = null; // allow retry on next request instead of caching a failure
        throw err;
      });
  }
  return mongoReady;
}

if (IS_SERVERLESS) {
  app.use(async (req, res, next) => {
    try {
      await ensureMongo();
      next();
    } catch (err) {
      res.status(500).json({ error: 'Database connection failed: ' + err.message });
    }
  });
}

// API routes (never cache — library progress bars must always be fresh)
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/books', booksRouter);
app.use('/api/annotations', annotationsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/vocab', makeEntriesRouter(Vocab));
app.use('/api/quotes', makeEntriesRouter(Quote, ['author']));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to index.html for any non-API route (simple SPA-ish routing)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (IS_SERVERLESS) {
  // Vercel calls this exported app directly as a request handler — no app.listen().
  module.exports = app;
} else {
  const PORT = process.env.PORT || 4000;
  ensureMongo()
    .then(() => {
      app.listen(PORT, () => console.log(`Book reader server running on http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('MongoDB connection error:', err.message);
      process.exit(1);
    });
}
