# 📚✨ Shelf — Read Anywhere, Never Lose Your Place

> *Because the best reading habit is the one that follows you everywhere.*

## The Story

I wanted to read more. Not "someday", but every day: on the bus, in bed, at my desk, in five spare minutes between things.

The problem was never the books. It was the **friction**:

- I'd highlight a passage on my PC, then open the same PDF on my phone and **none of it was there**.
- I'd draw a note in the margin, then lose it the moment I switched devices.
- I'd read until page 143, close the laptop, and later spend five minutes **hunting for where I stopped**.
- Keeping two copies of a PDF in sync by hand? Nobody sticks to that. And when reading is a chore, reading stops.

So I built **Shelf**: a self-hosted reader where I upload a book **once** and read it from **any device, any time**. Highlights, freehand drawings, notes and reading progress are all saved to the cloud, so I pick up **exactly where I left off**, with everything I marked, no manual syncing, no copying files around.

And since I don't always understand everything I read, there's an **Ask AI** panel: select a confusing passage and it explains it in plain, simple language, no analogies.

## What It Does

| Page | What you get |
|---|---|
| **Library** | Upload PDF/EPUB books once and see your whole shelf, with your progress on each book. |
| **Reader** | Full-screen reading on PC or phone, with highlighting, freehand drawing, an eraser, a page jump box and an **End reading** button that saves where you are. |
| **Words** | Every word or phrase you saved while reading, with your own explanation. Search, filter by book, or jump back to the page it came from. |
| **Quotes** | Every passage you saved, with your own notes, searchable and filterable by book. |

### Extras

- 🔁 **Cross-device sync**: progress, highlights and drawings live in MongoDB, not in one browser. Start on your PC, continue on your phone.
- 📍 **Resume exactly where you stopped**: the page *and* the scroll position are saved automatically as you read.
- 🖍️ **Highlights**: select text and it's saved as ratio coordinates (0–1 of the page), so it lines up on any screen size.
- ✏️ **Freehand drawing**: a transparent canvas over every page. Sketch, underline, circle things, and it's all saved.
- 🧽 **Eraser**: hold left click and drag over a highlight or stroke to remove it.
- 📝 **Words & Quotes**: tap **📝 Word** or **❝ Quote** on any selection, or type/paste your own.
- 🤖 **Ask AI**: select text (or type a follow-up) and get a very simple, child-level explanation with no analogies.
- ⛶ **Fullscreen mode**: native Fullscreen API toggle in the reader toolbar.
- ☁️ **Upload once, read anywhere**: books are stored server-side, so there's no copying PDFs between devices.

## How It Works

```
┌──────────────────┐                      ┌──────────────────────────┐
│  PC browser      │                      │  server/public/          │
│  Phone browser   │ ───────────────────► │  index.html · reader.html│
│  (same URL)      │   static UI + PDF.js │  (vanilla JS, no build)  │
└──────────────────┘                      └────────────┬─────────────┘
                                                       │  /api/*
                                                       ▼
                                          ┌──────────────────────────┐
                                          │  server/server.js        │
                                          │  (Express)               │
                                          │  books · annotations ·   │
                                          │  words · quotes · AI     │
                                          └───────┬──────────┬───────┘
                                                  │          │
                                                  ▼          ▼
                                        ┌────────────────┐  ┌──────────────────┐
                                        │ MongoDB Atlas  │  │ apmix.ai         │
                                        │ books, notes,  │  │ (Anthropic-      │
                                        │ progress, files│  │ compatible API)  │
                                        └────────────────┘  └──────────────────┘
```

- **Frontend**: static pages (`index.html`, `reader.html`) in vanilla HTML/CSS/JS with a local copy of PDF.js. No build step, no CDN dependency.
- **Backend**: an Express app in `server/server.js` that stores everything in MongoDB.
- **Files**: PDFs/EPUBs are stored in the cloud (MongoDB GridFS bucket `bookfiles`). On Vercel they go to **Vercel Blob**, auto-detected through `BLOB_READ_WRITE_TOKEN`. Locally, without that variable, they fall back to disk.
- **Hosting**: runs locally, on a small VPS, or on **Vercel** as a single serverless function that serves both the API and the static files.

### Under the hood

- **Reading position**: every scroll is debounced and saved as `{ lastPage, lastScrollRatio }` on the book document.
- **Highlights**: the browser's selection rectangles are converted to ratio coordinates and stored as a `highlight` annotation tied to a page.
- **Drawing**: strokes are captured as ratio-coordinate points and stored as `drawing` annotations, redrawn identically on any screen.
- **Ask AI**: selected text goes to `/api/ai/explain`, which calls `AI_BASE_URL/v1/messages`. The system prompt permanently enforces "explain like I'm a child, no analogies."

## Project Structure

```
Shelf/
├── api/
│   └── index.js               # Vercel entry point, re-exports server/server.js
├── server/
│   ├── server.js              # Express app (standalone or as the Vercel function)
│   ├── package.json           # deps for local npm install / npm start
│   ├── models/
│   │   ├── Book.js            # Book + reading-progress schema
│   │   └── Annotation.js      # Highlight / drawing schema
│   ├── routes/
│   │   ├── books.js           # Upload, list, stream file, progress, delete
│   │   ├── annotations.js     # CRUD for highlights and drawings
│   │   └── ai.js              # Calls apmix.ai with the child-level system prompt
│   ├── public/
│   │   ├── index.html, js/library.js   # Library / upload UI
│   │   ├── reader.html, js/reader.js   # PDF.js reader, highlight, draw, AI
│   │   ├── css/style.css
│   │   └── vendor/                     # local PDF.js
│   └── .env.example
├── package.json               # root deps for Vercel's install
└── vercel.json                # routes everything to api/index.js, bundles server/public/
```

## API Endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/books` | List every book in the library |
| `POST` | `/api/books` | Upload a PDF/EPUB |
| `GET` | `/api/books/:id/file` | Stream a book's file |
| `PUT` | `/api/books/:id/progress` | Save last page and scroll position |
| `DELETE` | `/api/books/:id` | Delete a book |
| `GET` / `POST` / `DELETE` | `/api/annotations` | Load, save and erase highlights and drawings |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/vocabs` | Saved words and your explanations |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/quotes` | Saved quotes and your notes |
| `POST` | `/api/ai/explain` | Ask AI to explain selected text in simple language |

> Check the exact paths against `server/routes/*.js` and adjust this table if they differ.

## Running Locally

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>/server
npm install
cp .env.example .env
```

Edit `.env`:

| Variable | What it is |
|---|---|
| `PORT` | Port the server runs on (default `4000`) |
| `MONGO_URI` | Your MongoDB connection string (local or Atlas) |
| `AI_BASE_URL` | `https://api.apmix.ai` |
| `AI_API_KEY` | Your apmix.ai API key |
| `AI_MODEL` | `claude-sonnet-4-6-free` |

Make sure MongoDB is running (`mongod`, or paste your Atlas URI), then:

```bash
npm start
```

Open `http://localhost:4000` on your PC. On your phone, open `http://<your-pc-lan-ip>:4000` on the same Wi-Fi. To read from anywhere, deploy it (below).

## Deploying on Vercel

Vercel's functions have a read-only, ephemeral filesystem, so uploaded books go to **Vercel Blob** instead of disk.

1. **Push to GitHub.**
2. **Import into Vercel** at [vercel.com/new](https://vercel.com/new). Framework preset: **Other**. **Leave Root Directory as the repo root**, not `server/`.
3. **Add MongoDB Atlas**: create a free cluster, allow `0.0.0.0/0` under Network Access, and copy the `mongodb+srv://...` string.
4. **Add a Vercel Blob store**: Project → Storage → Create Database → Blob. This injects `BLOB_READ_WRITE_TOKEN` automatically.
5. **Set environment variables** under Settings → Environment Variables: `MONGO_URI`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.
6. **Deploy**, then open the Vercel URL on your PC and phone. Same backend, same database, same highlights, drawings and place in the book.

### Vercel notes

- A 404 or HTML "page not found" on `/api/...` almost always means Root Directory points at `server/`. Fix it under Settings → General and redeploy.
- The first request after idle time is slower because it reconnects to MongoDB. Warm requests reuse the connection.
- The 200MB upload limit in the code is higher than Vercel's request body limit (a few MB on Hobby), so large PDFs may fail there but work fine on a VPS or locally.

## Limitations

- **EPUB** currently renders as plain continuous text. PDF is the fully built path (highlighting, drawing, resume). Swap in `epub.js` later for proper pagination; the ratio-based annotation system will work the same way.
- **Single-user by design**: no login, everything is stored globally. Add an `ownerId` field and auth if more people ever share the instance.

## Credits

- 📖 PDF.js, for rendering the books.
- 🤖 apmix.ai, for the Anthropic-compatible API behind Ask AI.
- ☕ Myself, for finally making reading easy enough to actually do.

*Personal project. Built to make reading a habit instead of a chore.*
