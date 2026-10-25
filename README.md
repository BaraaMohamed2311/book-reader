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

- **Upload** — PDF/EPUB files are stored in MongoDB (chunked, collection `bookchunks`) together with the book metadata.
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
- Eraser mode: hold left click and drag over a highlight or a drawn stroke to remove it on contact.

## Deploying on Vercel

Vercel's functions have a **read-only, ephemeral filesystem** — a file saved during one
request isn't there on the next one. So on Vercel this app stores uploaded books in
**Vercel Blob** instead of `server/uploads/` (it auto-detects this via the
`BLOB_READ_WRITE_TOKEN` env var — locally, without that var, it still just uses disk).

The repo root has:
- `api/index.js` — a one-line file that re-exports the Express app from `server/server.js`.
  Vercel auto-detects anything under `/api` as a serverless function (no config needed for that part).
- `package.json` — a root-level copy of the dependencies, since Vercel installs packages
  starting from the repo root, not from `server/package.json`.
- `vercel.json` — rewrites every request to that one function, and tells Vercel to bundle
  `server/public/**` into it (so `express.static` can actually find those files at runtime).

### Steps

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Import into Vercel**
   - Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo.
   - Framework preset: choose **"Other"**.
   - **Root Directory: leave it as the repo root** (don't point it at `server/`) — `vercel.json`,
     `package.json`, and `api/` all need to be visible from there, or Vercel won't find them and
     you'll get a 404 on every route, including `/api/...`.
   - Leave build/output settings default; `vercel.json` takes care of the rest.

3. **Add a MongoDB database Vercel can reach**
   - Use [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (free tier is fine) — Vercel's
     functions can't reach a `mongodb://127.0.0.1` on your own machine.
   - In Atlas: Network Access → allow `0.0.0.0/0` (or Vercel's IP ranges) so the functions can connect.
   - Copy the `mongodb+srv://...` connection string.

4. **Add a Vercel Blob store**
   - In your Vercel project → **Storage** tab → **Create Database** → **Blob**.
   - Connect it to the project — this automatically injects `BLOB_READ_WRITE_TOKEN` as an
     environment variable, so you don't need to set it by hand.

5. **Set environment variables**
   In the project → **Settings → Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `MONGO_URI` | your Atlas connection string |
   | `AI_BASE_URL` | `https://api.apmix.ai` |
   | `AI_API_KEY` | your apmix.ai API key |
   | `AI_MODEL` | `claude-sonnet-4-6-free` |

   (`BLOB_READ_WRITE_TOKEN` is already set automatically from step 4; `PORT` isn't needed on Vercel.)

6. **Deploy**
   - Click **Deploy**. Vercel builds `api/index.js` as a serverless function, bundling in
     `server/public/` (per `vercel.json`'s `includeFiles`), and `rewrites` sends every path —
     `/`, `/reader.html`, `/api/books`, etc. — to that one function, which is the Express app
     itself handling both static files and the API.
   - Once live, open the Vercel URL on both your PC and phone — same backend, same database,
     same highlights/drawings/resume-position on both.

### Notes specific to the Vercel deployment

- If you still get a 404 / an HTML "page not found" response instead of JSON from `/api/...`
  after deploying, it's almost always the **Root Directory** project setting pointing at `server/`
  instead of the repo root — fix it under Project → Settings → General → Root Directory, then redeploy.
- Cold starts: the first request after idle time connects to MongoDB, so it can be a bit
  slower; subsequent requests on the same warm instance reuse that connection.
- The 200MB upload limit in the code is higher than what Vercel's request body limit actually
  allows on serverless functions (typically a few MB on the Hobby plan) — large PDFs may fail
  to upload there even though they'd work fine on your own VPS/local server.

## Project structure

```
api/
  index.js               # Vercel entry point — just re-exports server/server.js
server/
  server.js              # Express app (works standalone locally, or as the Vercel function)
  package.json           # deps, for local `npm install` / `npm start`
  models/Book.js          # Book + reading-progress schema
  models/Annotation.js    # Highlight / drawing schema
  routes/books.js          # Upload, list, stream file, progress, delete
  routes/annotations.js    # CRUD for highlights/drawings
  routes/ai.js              # Calls apmix.ai with the child-level system prompt
  public/
    index.html, js/library.js   # Library / upload UI
    reader.html, js/reader.js   # PDF.js reader, highlight/draw/AI
    css/style.css
    vendor/                      # local copy of PDF.js (no external CDN dependency)
  .env.example
package.json              # deps for Vercel's root-level install
vercel.json                # routes everything to api/index.js, bundles server/public/
```
