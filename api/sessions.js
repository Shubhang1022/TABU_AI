const { connectDB } = require('./_db');
const { getOrCreateIds, setCookie } = require('./_cookies');
const { v4: uuidv4 } = require('uuid');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, chatId } = getOrCreateIds(req, res);
  const url = req.url || '';

  try {
    const sessions = await connectDB();

    // GET /api/sessions — list all chats
    if (req.method === 'GET') {
      const list = await sessions
        .find({ userId }, { projection: { sessionId: 1, title: 1, updatedAt: 1, createdAt: 1 } })
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();
      return res.json({ sessions: list });
    }

    // POST /api/sessions/new
    if (req.method === 'POST' && url.includes('new')) {
      const newChatId = uuidv4();
      setCookie(res, 'tabu_chat_id', newChatId, { httpOnly: false });
      return res.json({ chatId: newChatId });
    }

    // POST /api/sessions/switch
    if (req.method === 'POST' && url.includes('switch')) {
      const { chatId: targetId } = req.body || {};
      if (!targetId) return res.status(400).json({ error: 'chatId required' });
      const session = await sessions.findOne({ sessionId: targetId, userId });
      if (!session) return res.status(403).json({ error: 'Chat not found' });
      setCookie(res, 'tabu_chat_id', targetId, { httpOnly: false });
      return res.json({ ok: true, chatId: targetId });
    }

    // DELETE /api/sessions/:chatId
    if (req.method === 'DELETE') {
      const parts = url.split('/').filter(Boolean);
      const targetId = parts[parts.length - 1];
      if (targetId && targetId !== 'sessions') {
        await sessions.deleteOne({ sessionId: targetId, userId });
        return res.json({ ok: true });
      }
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('sessions error:', err);
    res.status(500).json({ error: String(err) });
  }
};
