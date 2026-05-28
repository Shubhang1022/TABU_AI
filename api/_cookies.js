const { v4: uuidv4 } = require('uuid');

function parseCookies(req) {
  const list = {};
  const header = req.headers?.cookie || '';
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) list[k.trim()] = decodeURIComponent(v.join('='));
  });
  return list;
}

function setCookie(res, name, value, opts = {}) {
  const maxAge = opts.maxAge || 365 * 24 * 60 * 60;
  const httpOnly = opts.httpOnly !== false ? '; HttpOnly' : '';
  const sameSite = '; SameSite=Lax';
  const secure = process.env.VERCEL ? '; Secure' : '';
  const existing = res.getHeader('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [existing];
  cookies.push(`${name}=${value}; Max-Age=${maxAge}; Path=/${httpOnly}${sameSite}${secure}`);
  res.setHeader('Set-Cookie', cookies);
}

function getOrCreateIds(req, res) {
  const cookies = parseCookies(req);

  let userId = cookies['tabu_user_id'];
  if (!userId) {
    userId = uuidv4();
    setCookie(res, 'tabu_user_id', userId, { httpOnly: true });
  }

  let chatId = cookies['tabu_chat_id'];
  if (!chatId) {
    chatId = uuidv4();
    setCookie(res, 'tabu_chat_id', chatId, { httpOnly: false });
  }

  return { userId, chatId };
}

module.exports = { parseCookies, setCookie, getOrCreateIds };
