# Shelf — synced highlight/draw book reader

Self-hosted PDF/EPUB reader: upload books, read them full-screen on PC or phone,
highlight text, draw/annotate freehand, and resume exactly where you left off —
because everything is saved to MongoDB, not a single browser.

Also includes an "Ask AI" panel: select text you don't understand and it's explained
in very simple, non-analogy language, using the apmix.ai Anthropic-compatible API.

## 1. Install

```bash
cd server
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Then edit `.env`:

| Variable | What it is |
|---|---|
| `PORT` | Port the server runs on (default `4000`) |
| `MONGO_URI` | Your MongoDB connection string (local or Atlas) |
| `AI_BASE_URL` | `https://api.apmix.ai` |
| `AI_API_KEY` | Your apmix.ai API key |
| `AI_MODEL` | `claude-sonnet-4-6-free` |

## 3. Run

Make sure MongoDB is running (locally: `mongod`, or use Atlas and paste its URI into `MONGO_URI`).

```bash
npm start
```

Open `http://localhost:4000` on your PC. On your phone, open `http://<your-pc-lan-ip>:4000`
while on the same Wi-Fi (or deploy it to any small VPS so it's reachable from anywhere —
that's what makes the sync actually cross-device).

## How it works

- **Upload** — PDF/EPUB files are stored in MongoDB Atlas (GridFS bucket `bookfiles`) and linked to the book document in `books` via `fileId`.
- **Reading position** — every scroll is debounced and saved as `{ lastPage, lastScrollRatio }` on the
  `Book` document, so reopening a book resumes exactly there, on any device.
- **Highlights** — selecting text captures the browser's selection rectangles, converts them to
  ratio coordinates (0–1 of the page), and stores them as a `highlight` annotation tied to that page.
  They're redrawn at those same ratios regardless of screen size.
- **Drawing** — a transparent canvas sits over each page; strokes are captured as ratio-coordinate
  points and saved as `drawing` annotations, redrawn the same way.
- **Fullscreen** — the reader toolbar has a fullscreen toggle (`⛶`) using the native Fullscreen API.
- **Ask AI** — selected text (or a typed follow-up) is sent to `/api/ai/explain`, which calls
  `AI_BASE_URL/v1/messages` with your `AI_API_KEY`. The system prompt permanently enforces
  "explain like I'm a child, no analogies," regardless of what's asked.

## Notes / limitations of this build

- EPUB currently renders as plain continuous text (no pagination/epub.js yet) — PDF is the fully
  built-out path with highlighting, drawing, and resume-position. Swap in `epub.js` if you want
  proper EPUB pagination later; the annotation system (ratio-based rects/points per "page") will
  still work the same way.
- This is single-user by design (no login) — every book/annotation is just stored globally. Add
  an `ownerId` field + auth if you ever need multiple people on the same instance.
- Eraser mode: click a highlight to delete it; double-click a page's drawing layer to clear all
  drawings on that page.

## Project structure

```
server/
  server.js            # Express app entry
  models/Book.js        # Book + reading-progress schema
  models/Annotation.js  # Highlight / drawing schema
  routes/books.js        # Upload, list, stream file, progress, delete
  routes/annotations.js  # CRUD for highlights/drawings
  routes/ai.js            # Calls apmix.ai with the child-level system prompt
  public/
    index.html, js/library.js   # Library / upload UI
    reader.html, js/reader.js   # PDF.js reader, highlight/draw/AI
    css/style.css
  .env.example
```
