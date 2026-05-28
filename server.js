const express = require('express');
const path = require('path');
const fs = require('fs');
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
const OR_MODEL          = process.env.OPENROUTER_MODEL   || 'google/gemma-4-31b-it:free';
const MONGO_URI         = process.env.MONGODB_URI;

// ── MongoDB (lazy connect — safe for serverless) ──────────────
let mongoConnected = false;
let Session = null;

async function connectMongo() {
  if (mongoConnected || !MONGO_URI) return;
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000
    });
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
      userId:    { type: String, required: true, index: true }, // cookie-based user ID
      title:     { type: String, default: 'New Chat' },
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

// Static files — resolve relative to this file for Vercel compatibility
const staticDir = path.resolve(__dirname);
app.use(express.static(staticDir));

// Serve index.html at root
app.get('/', (req, res) => {
  const htmlPath = path.join(staticDir, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('index.html not found');
  }
});
// userId = permanent cookie identifying the browser (never changes)
// chatId  = active chat session (changes when user starts a new chat)
app.use((req, res, next) => {
  // Permanent user ID
  let userId = req.cookies?.tabu_user_id;
  if (!userId) {
    userId = uuidv4();
    res.cookie('tabu_user_id', userId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax'
    });
  }
  req.userId = userId;

  // Active chat ID (can be switched by client)
  let chatId = req.cookies?.tabu_chat_id;
  if (!chatId) {
    chatId = uuidv4();
    res.cookie('tabu_chat_id', chatId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false, // readable by JS so client can switch chats
      sameSite: 'lax'
    });
  }
  req.sessionId = chatId;
  next();
});

// ── DB helpers ────────────────────────────────────────────────
async function getSession(sessionId, userId) {
  if (!Session) return null;
  let session = await Session.findOne({ sessionId });
  if (!session) session = await Session.create({ sessionId, userId: userId || 'unknown', title: 'New Chat', messages: [] });
  return session;
}

async function saveMessages(sessionId, userId, userMsg, assistantMsg, type = 'text') {
  if (!Session) return;
  // Auto-title: use first user message (truncated) as chat title
  const session = await Session.findOne({ sessionId });
  const isFirst = !session || session.messages.length === 0;
  const title = isFirst ? userMsg.replace(/\[Image\]|\[Voice\]/g, '').trim().slice(0, 50) : undefined;

  const update = {
    $push: {
      messages: {
        $each: [
          { role: 'user',      content: userMsg,      type, timestamp: new Date() },
          { role: 'assistant', content: assistantMsg, type, timestamp: new Date() }
        ]
      }
    },
    $set: { updatedAt: new Date(), userId }
  };
  if (title) update.$set.title = title;

  await Session.findOneAndUpdate({ sessionId }, update, { upsert: true });
}

// ── Routes ────────────────────────────────────────────────────

// GET /api/sessions — list all chats for this user
app.get('/api/sessions', async (req, res) => {
  try {
    await connectMongo();
    if (!Session) return res.json({ sessions: [] });
    const sessions = await Session.find({ userId: req.userId })
      .select('sessionId title updatedAt createdAt')
      .sort({ updatedAt: -1 })
      .limit(50);
    res.json({ sessions });
  } catch (err) {
    console.error('Sessions error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions/new — create a new chat session
app.post('/api/sessions/new', async (req, res) => {
  try {
    const newChatId = uuidv4();
    res.cookie('tabu_chat_id', newChatId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });
    res.json({ chatId: newChatId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions/switch — switch to an existing chat
app.post('/api/sessions/switch', async (req, res) => {
  try {
    const { chatId } = req.body || {};
    if (!chatId) return res.status(400).json({ error: 'chatId required' });
    // Verify this chat belongs to this user
    await connectMongo();
    const session = Session ? await Session.findOne({ sessionId: chatId, userId: req.userId }) : null;
    if (!session) return res.status(403).json({ error: 'Chat not found' });
    res.cookie('tabu_chat_id', chatId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });
    res.json({ ok: true, chatId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/sessions/:chatId — delete a specific chat
app.delete('/api/sessions/:chatId', async (req, res) => {
  try {
    await connectMongo();
    if (Session) {
      await Session.deleteOne({ sessionId: req.params.chatId, userId: req.userId });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/history — load active chat messages
app.get('/api/history', async (req, res) => {
  try {
    await connectMongo();
    const session = await getSession(req.sessionId, req.userId);
    const messages = session ? session.messages.slice(-100) : [];
    res.json({ messages });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/chat — Gemini (text chat)
app.post('/api/chat', async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set on server' });

    const { message, maxTokens = 8000, temperature = 0.7 } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    await connectMongo();
    const session = await getSession(req.sessionId, req.userId);
    const history = session ? session.messages.slice(-20) : [];

    // Build Gemini contents array from history + new message
    const contents = [
      ...history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const payload = {
      contents,
      generationConfig: {
        maxOutputTokens: Math.min(Number(maxTokens) || 8000, 16000),
        temperature: Number(temperature) || 0.7
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

    await saveMessages(req.sessionId, req.userId, message, aiText, 'text');
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
    await saveMessages(req.sessionId, req.userId, `[Image] ${prompt}`, aiText, 'image');
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
    const session = await getSession(req.sessionId, req.userId);
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

    await saveMessages(req.sessionId, req.userId, `[Voice] ${transcript}`, aiText, 'voice');
    res.json({ text: aiText });
  } catch (err) {
    console.error('Speech error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Only listen locally
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`TABU AI running: http://localhost:${PORT}`));
}

module.exports = app;
