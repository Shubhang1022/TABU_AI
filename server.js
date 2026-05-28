const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/responses';
const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  console.error('Missing GROQ_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve static files (your index.html and assets)
app.use(express.static(path.join(__dirname)));

// Simple /api/generate proxy to Groq (keeps key server-side)
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, maxTokens = 20000, temperature = 0.7 } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const payload = {
      // Groq/OpenAI-compat style responses endpoint payload
      input: prompt,
      // If Groq expects different fields change here accordingly
      max_output_tokens: Math.min(Number(maxTokens) || 20000, 200000),
      temperature: Number(temperature) || 0.7
    };

    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();
    if (!r.ok) {
      let body = raw;
      try { body = JSON.parse(raw); } catch (e) {}
      return res.status(r.status).json({ error: body });
    }

    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = { raw }; }

    // try to extract assistant text from common response shapes
    let aiText = '';
    // Groq (OpenAI-compatible) -> maybe data.output_text or data.candidates[...] etc.
    if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      aiText = data.candidates[0].content.parts[0].text;
    } else if (data?.output_text) {
      aiText = data.output_text;
    } else if (data?.text) {
      aiText = data.text;
    } else if (typeof data === 'string') {
      aiText = data;
    } else {
      aiText = JSON.stringify(data);
    }

    return res.json({ text: aiText, raw: data });
  } catch (err) {
    console.error('Proxy error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Proxy + static server running: http://localhost:${PORT}`));
