const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = process.env.OPENROUTER_API_KEY;
const API_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

if (!API_KEY) {
  console.error('Missing OPENROUTER_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve static files (index.html and assets)
app.use(express.static(path.join(__dirname)));

// Proxy endpoint — keeps API key server-side
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, maxTokens = 8000, temperature = 0.7 } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const payload = {
      model: API_MODEL,
      messages,
      max_tokens: Math.min(Number(maxTokens) || 8000, 16000),
      temperature: Number(temperature) || 0.7
    };

    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'HTTP-Referer': 'https://tabu-ai.vercel.app',
        'X-Title': 'TABU AI'
      },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();

    if (!r.ok) {
      let body = raw;
      try { body = JSON.parse(raw); } catch (e) {}
      console.error('OpenRouter error:', r.status, body);
      return res.status(r.status).json({ error: body });
    }

    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = { raw }; }

    // Extract assistant text from OpenAI-compatible response
    const aiText = data?.choices?.[0]?.message?.content || '';

    return res.json({ text: aiText });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`TABU AI server running: http://localhost:${PORT}`));
