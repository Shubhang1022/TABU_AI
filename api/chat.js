const { connectDB } = require('./_db');
const { getOrCreateIds } = require('./_cookies');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: `Method ${req.method} not allowed` });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const { userId, chatId } = getOrCreateIds(req, res);
  const { message, maxTokens = 8000, temperature = 0.7 } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    const sessions = await connectDB();

    // Load history
    const session = await sessions.findOne({ sessionId: chatId });
    const history = session ? session.messages.slice(-20) : [];

    // Build Gemini contents
    const contents = [
      ...history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: Math.min(Number(maxTokens) || 8000, 16000),
          temperature: Number(temperature) || 0.7
        }
      })
    });

    const raw = await r.text();
    if (!r.ok) {
      let body = raw; try { body = JSON.parse(raw); } catch (e) {}
      return res.status(r.status).json({ error: body });
    }

    const data = JSON.parse(raw);
    const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Save messages
    const isFirst = !session || session.messages.length === 0;
    await sessions.updateOne(
      { sessionId: chatId },
      {
        $push: { messages: { $each: [
          { role: 'user', content: message, type: 'text', timestamp: new Date() },
          { role: 'assistant', content: aiText, type: 'text', timestamp: new Date() }
        ]}},
        $set: { updatedAt: new Date(), userId, ...(isFirst ? { title: message.slice(0, 50) } : {}) },
        $setOnInsert: { sessionId: chatId, createdAt: new Date() }
      },
      { upsert: true }
    );

    res.json({ text: aiText });
  } catch (err) {
    console.error('chat error:', err);
    res.status(500).json({ error: String(err) });
  }
};
