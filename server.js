const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── API config ────────────────────────────────────────────────
const GEMINI_KEY        = process.env.GEMINI_API_KEY;
const GEMINI_URL        = process.env.GEMINI_API_URL  || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_VISION_URL = process.env.GEMINI_VISION_URL || GEMINI_URL;
const OR_KEY            = process.env.OPENROUTER_API_KEY;
const OR_URL            = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const OR_MODEL          = process.env.OPENROUTER_MODEL   || 'google/gemini-2.5-flash';
const MONGO_URI         = process.env.MONGODB_URI;

// ── MongoDB (lazy connect — safe for serverless) ──────────────
let mongoConnected = false;
let Session = null;

async function connectMongo() {
  if (mongoConnected || !MONGO_URI) return;
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    mongoConnected = true;
    console.log('MongoDB connected');

    const messageSchema = new mongoose.Schema({
      role:      { type: String, enum: ['user', 'assistant'], required: true },
      content:   { type: String, required: true },
      type:      { type: String, default: 'text' },
      timestamp: { type: Date, default: Date.now }
    });

    const sessionSchema = new mongoose.Schema({
      sessionId: { type: String, required: true, unique: true, index: true },
      messages:  [messageSchema],
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    });

    Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

// ── Express setup ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname)));

// ── Session middleware ────────────────────────────────────────
app.use((req, res, next) => {
  let sid = req.cookies?.tabu_session_id;
  if (!sid) {
    sid = uuidv4();
    res.cookie('tabu_session_id', sid, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax'
    });
  }
  req.sessionId = sid;
  next();
});

// ── DB helpers ────────────────────────────────────────────────
async function getSession(sessionId) {
  if (!Session) return null;
  let session = await Session.findOne({ sessionId });
  if (!session) session = await Session.create({ sessionId, messages: [] });
  return session;
}

async function saveMessages(sessionId, userMsg, assistantMsg, type = 'text') {
  if (!Session) return;
  await Session.findOneAndUpdate(
    { sessionId },
    {
      $push: {
        messages: {
          $each: [
            { role: 'user',      content: userMsg,      type, timestamp: new Date() },
            { role: 'assistant', content: assistantMsg, type, timestamp: new Date() }
          ]
        }
      },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
}

// ── Routes ────────────────────────────────────────────────────

// Serve index.html
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    await connectMongo();
    const session = await getSession(req.sessionId);
    const messages = session ? session.messages.slice(-100) : [];
    res.json({ messages });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/history
app.delete('/api/history', async (req, res) => {
  try {
    await connectMongo();
    if (Session) {
      await Session.findOneAndUpdate(
        { sessionId: req.sessionId },
        { $set: { messages: [], updatedAt: new Date() } }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/chat — OpenRouter
app.post('/api/chat', async (req, res) => {
  try {
    if (!OR_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not set on server' });

    const { message, maxTokens = 8000, temperature = 0.7 } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    await connectMongo();
    const session = await getSession(req.sessionId);
    const history = session ? session.messages.slice(-20) : [];

    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    const payload = {
      model: OR_MODEL,
      messages,
      max_tokens: Math.min(Number(maxTokens) || 8000, 16000),
      temperature: Number(temperature) || 0.7
    };

    const r = await fetch(OR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OR_KEY}`,
        'HTTP-Referer': 'https://tabu-ai.vercel.app',
        'X-Title': 'TABU AI'
      },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();
    if (!r.ok) {
      let body = raw; try { body = JSON.parse(raw); } catch (e) {}
      return res.status(r.status).json({ error: body });
    }

    const data = JSON.parse(raw);
    const aiText = data?.choices?.[0]?.message?.content || '';

    await saveMessages(req.sessionId, message, aiText, 'text');
    res.json({ text: aiText });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/vision — Gemini
app.post('/api/vision', async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });

    const { message, imageBase64, mimeType = 'image/jpeg', maxTokens = 8000 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const prompt = message || 'Analyze this image and describe what you see.';
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64 } }
        ]
      }],
      generationConfig: {
        maxOutputTokens: Math.min(Number(maxTokens) || 8000, 16000),
        temperature: 0.7
      }
    };

    const url = `${GEMINI_VISION_URL}?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();
    if (!r.ok) {
      let body = raw; try { body = JSON.parse(raw); } catch (e) {}
      return res.status(r.status).json({ error: body });
    }

    const data = JSON.parse(raw);
    const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    await connectMongo();
    await saveMessages(req.sessionId, `[Image] ${prompt}`, aiText, 'image');
    res.json({ text: aiText });
  } catch (err) {
    console.error('Vision error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/speech — Gemini
app.post('/api/speech', async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });

    const { transcript, maxTokens = 8000 } = req.body || {};
    if (!transcript) return res.status(400).json({ error: 'transcript required' });

    await connectMongo();
    const session = await getSession(req.sessionId);
    const history = session ? session.messages.slice(-10) : [];
    const contextText = history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    const prompt = contextText ? `${contextText}\n\nUser: ${transcript}\n\nAssistant:` : transcript;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: Math.min(Number(maxTokens) || 8000, 16000),
        temperature: 0.7
      }
    };

    const url = `${GEMINI_URL}?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await r.text();
    if (!r.ok) {
      let body = raw; try { body = JSON.parse(raw); } catch (e) {}
      return res.status(r.status).json({ error: body });
    }

    const data = JSON.parse(raw);
    const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    await saveMessages(req.sessionId, `[Voice] ${transcript}`, aiText, 'voice');
    res.json({ text: aiText });
  } catch (err) {
    console.error('Speech error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Only listen when running locally (not on Vercel)
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`TABU AI running: http://localhost:${PORT}`));
}

module.exports = app;
