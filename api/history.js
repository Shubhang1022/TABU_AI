const { connectDB } = require('./_db');
const { getOrCreateIds } = require('./_cookies');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { userId, chatId } = getOrCreateIds(req, res);

  try {
    const { Session } = await connectDB();

    if (req.method === 'GET') {
      let session = await Session.findOne({ sessionId: chatId });
      if (!session) session = await Session.create({ sessionId: chatId, userId, title: 'New Chat', messages: [] });
      return res.json({ messages: session.messages.slice(-100) });
    }

    if (req.method === 'DELETE') {
      await Session.findOneAndUpdate({ sessionId: chatId }, { $set: { messages: [], updatedAt: new Date() } });
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('history error:', err);
    res.status(500).json({ error: String(err) });
  }
};
