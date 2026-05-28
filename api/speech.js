const { connectDB } = require('./_db');
const { getOrCreateIds } = require('./_cookies');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const { userId, chatId } = getOrCreateIds(req, res);
  const { transcript, maxTokens = 8000 } = req.body || {};
  if (!transcript) return res.status(400).json({ error: 'transcript required' });

  try {
    const { Session } = await connectDB();
    let session = await Session.findOne({ sessionId: chatId });
    const history = session ? session.messages.slice(-10) : [];
    const contextText = history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
    const prompt = contextText ? `${contextText}\n\nUser: ${transcript}\n\nAssistant:` : transcript;

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: Math.min(Number(maxTokens) || 8000, 16000),
          temperature: 0.7
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

    await Session.findOneAndUpdate(
      { sessionId: chatId },
      {
        $push: { messages: { $each: [
          { role: 'user', content: `[Voice] ${transcript}`, type: 'voice', timestamp: new Date() },
          { role: 'assistant', content: aiText, type: 'voice', timestamp: new Date() }
        ]}},
        $set: { updatedAt: new Date(), userId }
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ text: aiText });
  } catch (err) {
    console.error('speech error:', err);
    res.status(500).json({ error: String(err) });
  }
};
