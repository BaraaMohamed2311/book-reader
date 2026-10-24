require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// Fix for environments whose default DNS resolver can't resolve Mongo Atlas
// SRV records (ETIMEOUT / querySrv errors) — point Node's resolver at public DNS.
const dns = require('node:dns/promises');
dns.setServers(['1.1.1.1', '1.0.0.1']);

const booksRouter = require('./routes/books');
const annotationsRouter = require('./routes/annotations');
const aiRouter = require('./routes/ai');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/books', booksRouter);
app.use('/api/annotations', annotationsRouter);
app.use('/api/ai', aiRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to index.html for any non-API route (simple SPA-ish routing)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/book_reader';

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Book reader server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
