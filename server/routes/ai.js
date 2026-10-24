const express = require('express');
const axios = require('axios');

const router = express.Router();

// System instruction that is ALWAYS enforced, no matter what the user pastes/asks.
const BASE_SYSTEM_PROMPT = `You explain text that the user copy-pasted from a book because they did not understand it.
Hard constraint, always, for every single reply, no exceptions: explain at a CHILD level, using simple short words,
and NEVER use analogies, metaphors, or comparisons to unrelated things (no "it's like a...", no "imagine a...").
Just explain plainly and directly what the text means, step by step if needed, using only simple vocabulary a young
child could follow. Keep it short and clear.`;

router.post('/explain', async (req, res) => {
  try {
    const { text, question } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'No text provided to explain' });
    }

    const baseURL = process.env.AI_BASE_URL || 'https://api.apmix.ai';
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL || 'claude-sonnet-4-6-free';

    if (!apiKey) {
      return res.status(500).json({ error: 'AI_API_KEY is not configured on the server (.env)' });
    }

    const userContent = question
      ? `Text from the book:\n"""${text}"""\n\nMy question about it: ${question}`
      : `Explain this text from the book:\n"""${text}"""`;

    const response = await axios.post(
      `${baseURL}/v1/messages`,
      {
        model,
        max_tokens: 1024,
        system: BASE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      },
      {
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 60000
      }
    );

    // Anthropic-style response: { content: [{ type: 'text', text: '...' }], ... }
    const blocks = response.data && response.data.content;
    const explanation = Array.isArray(blocks)
      ? blocks.map((b) => b.text || '').join('\n').trim()
      : '';

    res.json({ explanation: explanation || 'No explanation returned.' });
  } catch (err) {
    const detail = err.response && err.response.data ? err.response.data : err.message;
    console.error('AI explain error:', detail);
    res.status(502).json({ error: 'Failed to get an explanation from the AI service', detail });
  }
});

module.exports = router;
