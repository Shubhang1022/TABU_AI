const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

if (!API_KEY || API_KEY === 'your_gemini_api_key_here') {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve static files (index.html and assets)
app.use(express.static(path.join(__dirname)));

// Explicitly serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Proxy endpoint — keeps Gemini API key server-side
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, maxTokens = 8000, temperature = 0.7 } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Convert OpenAI-style messages to Gemini format
    const prompt = messages.map(m => m.content).join('\n\n');

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: Math.min(Number(maxTokens) || 8000, 16000),
        temperature: Number(temperature) || 0.7
      }
    };

    const url = `${API_URL}?key=${API_KEY}`;

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();

    if (!r.ok) {
      let body = raw;
      try { body = JSON.parse(raw); } catch (e) {}
      console.error('Gemini error:', r.status, body);
      return res.status(r.status).json({ error: body });
    }

    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = { raw }; }

    // Extract text from Gemini response
    const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.json({ text: aiText });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`TABU AI server running: http://localhost:${PORT}`));
