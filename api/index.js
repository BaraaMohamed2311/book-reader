// Vercel recognizes any file under /api as a serverless function automatically.
// This just re-exports the actual Express app so Vercel calls it directly.
module.exports = require('../server/server.js');
