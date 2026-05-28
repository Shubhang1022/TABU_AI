const { connectDB } = require('./_db');
const { getOrCreateIds } = require('./_cookies');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const { userId, chatId } = getOrCreateIds(req, res);
  const { message, maxTokens = 8000, temperature = 0.7 } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    const { Session } = await connectDB();

    // Load history
    let session = await Session.findOne({ sessionId: chatId });
    if (!session) session = await Session.create({ sessionId: chatId, userId, title: 'New Chat', messages: [] });
    const history = session.messages.slice(-20);

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

    // Save messages + auto-title
    const isFirst = session.messages.length === 0;
    const update = {
      $push: { messages: { $each: [
        { role: 'user', content: message, type: 'text', timestamp: new Date() },
        { role: 'assistant', content: aiText, type: 'text', timestamp: new Date() }
      ]}},
      $set: { updatedAt: new Date(), userId }
    };
    if (isFirst) update.$set.title = message.slice(0, 50);
    await Session.findOneAndUpdate({ sessionId: chatId }, update, { upsert: true });

    res.json({ text: aiText });
  } catch (err) {
    console.error('chat error:', err);
    res.status(500).json({ error: String(err) });
  }
};
