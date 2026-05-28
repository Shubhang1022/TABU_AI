const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = 'tabuai';

// ── MongoDB connection ────────────────────────────────────────
let _client = null;
async function getCollection() {
  if (!_client) {
    _client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    await _client.connect();
    console.log('MongoDB connected');
  }
  return _client.db(DB_NAME).collection('sessions');
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(express.static(path.resolve(__dirname)));

// ── Cookie helpers ────────────────────────────────────────────
app.use((req, res, next) => {
  let userId = req.cookies?.tabu_user_id;
  if (!userId) {
    userId = uuidv4();
    res.cookie('tabu_user_id', userId, { maxAge: 365*24*60*60*1000, httpOnly: true, sameSite: 'lax' });
  }
  let chatId = req.cookies?.tabu_chat_id;
  if (!chatId) {
    chatId = uuidv4();
    res.cookie('tabu_chat_id', chatId, { maxAge: 365*24*60*60*1000, httpOnly: false, sameSite: 'lax' });
  }
  req.userId = userId;
  req.chatId = chatId;
  next();
});

// ── Routes ────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

// GET /api/sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const col = await getCollection();
    const list = await col.find({ userId: req.userId }, { projection: { sessionId:1, title:1, updatedAt:1, createdAt:1 } })
      .sort({ updatedAt: -1 }).limit(50).toArray();
    res.json({ sessions: list });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /api/sessions/new
app.post('/api/sessions/new', (req, res) => {
  const newChatId = uuidv4();
  res.cookie('tabu_chat_id', newChatId, { maxAge: 365*24*60*60*1000, httpOnly: false, sameSite: 'lax' });
  res.json({ chatId: newChatId });
});

// POST /api/sessions/switch
app.post('/api/sessions/switch', async (req, res) => {
  try {
    const { chatId: targetId } = req.body || {};
    if (!targetId) return res.status(400).json({ error: 'chatId required' });
    const col = await getCollection();
    const session = await col.findOne({ sessionId: targetId, userId: req.userId });
    if (!session) return res.status(403).json({ error: 'Chat not found' });
    res.cookie('tabu_chat_id', targetId, { maxAge: 365*24*60*60*1000, httpOnly: false, sameSite: 'lax' });
    res.json({ ok: true, chatId: targetId });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// DELETE /api/sessions/:chatId
app.delete('/api/sessions/:chatId', async (req, res) => {
  try {
    const col = await getCollection();
    await col.deleteOne({ sessionId: req.params.chatId, userId: req.userId });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    const col = await getCollection();
    const session = await col.findOne({ sessionId: req.chatId });
    res.json({ messages: session ? session.messages.slice(-100) : [] });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// DELETE /api/history
app.delete('/api/history', async (req, res) => {
  try {
    const col = await getCollection();
    await col.updateOne({ sessionId: req.chatId }, { $set: { messages: [], updatedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    const { message, maxTokens = 8000, temperature = 0.7 } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    const col = await getCollection();
    const session = await col.findOne({ sessionId: req.chatId });
    const history = session ? session.messages.slice(-20) : [];

    const contents = [
      ...history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: Math.min(Number(maxTokens)||8000,16000), temperature: Number(temperature)||0.7 } })
    });

    const raw = await r.text();
    if (!r.ok) { let b=raw; try{b=JSON.parse(raw);}catch(e){} return res.status(r.status).json({ error: b }); }

    const aiText = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const isFirst = !session || session.messages.length === 0;

    await col.updateOne(
      { sessionId: req.chatId },
      {
        $push: { messages: { $each: [
          { role: 'user', content: message, type: 'text', timestamp: new Date() },
          { role: 'assistant', content: aiText, type: 'text', timestamp: new Date() }
        ]}},
        $set: { updatedAt: new Date(), userId: req.userId, ...(isFirst ? { title: message.slice(0,50) } : {}) },
        $setOnInsert: { sessionId: req.chatId, createdAt: new Date() }
      },
      { upsert: true }
    );

    res.json({ text: aiText });
  } catch (err) { console.error(err); res.status(500).json({ error: String(err) }); }
});

// POST /api/vision
app.post('/api/vision', async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    const { message, imageBase64, mimeType = 'image/jpeg', maxTokens = 8000 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    const prompt = message || 'Analyze this image.';

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }], generationConfig: { maxOutputTokens: Math.min(Number(maxTokens)||8000,16000), temperature: 0.7 } })
    });

    const raw = await r.text();
    if (!r.ok) { let b=raw; try{b=JSON.parse(raw);}catch(e){} return res.status(r.status).json({ error: b }); }
    const aiText = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const col = await getCollection();
    await col.updateOne({ sessionId: req.chatId }, { $push: { messages: { $each: [
      { role: 'user', content: `[Image] ${prompt}`, type: 'image', timestamp: new Date() },
      { role: 'assistant', content: aiText, type: 'image', timestamp: new Date() }
    ]}}, $set: { updatedAt: new Date(), userId: req.userId }, $setOnInsert: { sessionId: req.chatId, createdAt: new Date(), title: `[Image] ${prompt}`.slice(0,50) } }, { upsert: true });

    res.json({ text: aiText });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /api/speech
app.post('/api/speech', async (req, res) => {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    const { transcript, maxTokens = 8000 } = req.body || {};
    if (!transcript) return res.status(400).json({ error: 'transcript required' });

    const col = await getCollection();
    const session = await col.findOne({ sessionId: req.chatId });
    const history = session ? session.messages.slice(-10) : [];
    const ctx = history.map(m => `${m.role==='user'?'User':'Assistant'}: ${m.content}`).join('\n');
    const prompt = ctx ? `${ctx}\n\nUser: ${transcript}\n\nAssistant:` : transcript;

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: Math.min(Number(maxTokens)||8000,16000), temperature: 0.7 } })
    });

    const raw = await r.text();
    if (!r.ok) { let b=raw; try{b=JSON.parse(raw);}catch(e){} return res.status(r.status).json({ error: b }); }
    const aiText = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    await col.updateOne({ sessionId: req.chatId }, { $push: { messages: { $each: [
      { role: 'user', content: `[Voice] ${transcript}`, type: 'voice', timestamp: new Date() },
      { role: 'assistant', content: aiText, type: 'voice', timestamp: new Date() }
    ]}}, $set: { updatedAt: new Date(), userId: req.userId }, $setOnInsert: { sessionId: req.chatId, createdAt: new Date(), title: transcript.slice(0,50) } }, { upsert: true });

    res.json({ text: aiText });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.listen(PORT, () => console.log(`TABU AI running: http://localhost:${PORT}`));
