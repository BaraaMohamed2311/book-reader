# Deploy to Vercel

## Root Directory: repo root (server/ also works)
Everything Vercel needs (server.js, package.json, public/, .vercelignore) is inside `server/`.
Deploying from the repo root fails, so don't use it.

## Steps
1. Push the project to GitHub (the repo root contains the `server/` folder).
2. MongoDB Atlas -> Network Access -> add `0.0.0.0/0` (Vercel has no fixed IPs).
3. Vercel -> Add New Project -> import the repo.
   - Root Directory: click Edit, choose `server`
   - Framework Preset: Other (or Express if auto-detected)
   - Build/Output settings: leave empty.
4. Project -> Storage -> Create Blob store -> Connect to this project (adds BLOB_READ_WRITE_TOKEN).
5. Settings -> Environment Variables (Production + Preview):
   - MONGO_URI = your Atlas URI (include /book_reader, URL-encode special chars in the password)
   - AI_BASE_URL = https://api.apmix.ai
   - AI_API_KEY = your key
   - AI_MODEL = claude-sonnet-4-6-free
6. Deploy / Redeploy after adding env vars and Blob.
7. Check https://YOUR-APP.vercel.app/api/health -> {"ok":true}

## Notes
- Vercel rejects request bodies over 4.5 MB, so on Vercel the browser uploads books straight to Blob.
- Locally: `cd server && npm install && npm start` (files saved in server/uploads).

## End reading button
In the reader, press "End reading": the current page and scroll position are saved immediately,
and you return to the library, where the book's progress bar and "Page X of Y" are updated.
