import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

let pool = null;
let dbReady = false;
const sessions = new Map();
const onlineUsers = new Map();
const wsNickname = new Map();

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    pool.on('error', (err) => console.error('[pg pool]', err.message));
    initDB().catch(err => console.error('[DB init]', err.message));
  } catch (e) {
    console.error('[pg create]', e.message);
  }
} else {
  console.warn('⚠️ DATABASE_URL не задан');
}

async function initDB(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      kk INTEGER DEFAULT 200,
      trophies INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      kills INTEGER DEFAULT 0,
      games INTEGER DEFAULT 0,
      unlocked JSONB DEFAULT '{"plant_0":true,"plant_1":true,"plant_2":true,"inv_0":true}'::jsonb,
      levels JSONB DEFAULT '{}'::jsonb,
      selected JSONB DEFAULT '{"plant":"plant_0","enemy":"inv_0"}'::jsonb,
      daily_last TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trophies ON players(trophies DESC)');
  await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS password_salt TEXT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      player1 TEXT NOT NULL,
      player2 TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(player1, player2)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_friend_p1 ON friendships(player1)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_friend_p2 ON friendships(player2)');
  dbReady = true;
  console.log('✅ БД готова');
}

function hashPassword(password, salt){ return crypto.scryptSync(password, salt, 64).toString('hex'); }
function genSalt(){ return crypto.randomBytes(16).toString('hex'); }
function genToken(){ return crypto.randomBytes(32).toString('hex'); }

async function registerPlayer(nickname, password){
  const existing = await pool.query('SELECT id, password_hash FROM players WHERE nickname = $1', [nickname]);
  if (existing.rows.length > 0) {
    if (existing.rows[0].password_hash) throw new Error('Ник занят');
    const salt = genSalt();
    const hash = hashPassword(password, salt);
    await pool.query('UPDATE players SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, existing.rows[0].id]);
  } else {
    const salt = genSalt();
    const hash = hashPassword(password, salt);
    await pool.query('INSERT INTO players (nickname, password_hash, password_salt) VALUES ($1, $2, $3)', [nickname, hash, salt]);
  }
  const token = genToken();
  sessions.set(token, { nickname, expires: Date.now() + 30*24*3600*1000 });
  return token;
}

async function loginPlayer(nickname, password){
  const r = await pool.query('SELECT * FROM players WHERE nickname = $1', [nickname]);
  if (r.rows.length === 0) throw new Error('Игрок не найден');
  const p = r.rows[0];
  if (!p.password_hash) throw new Error('Аккаунт без пароля');
  const hash = hashPassword(password, p.password_salt);
  if (hash !== p.password_hash) throw new Error('Неверный пароль');
  const token = genToken();
  sessions.set(token, { nickname, expires: Date.now() + 30*24*3600*1000 });
  return token;
}

function authByToken(token){
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s.nickname;
}

async function getPlayer(nickname){
  const r = await pool.query('SELECT nickname, kk, trophies, wins, losses, kills, games, unlocked, levels, selected, daily_last FROM players WHERE nickname = $1', [nickname]);
  return r.rows[0] || null;
}

async function updatePlayer(nickname, data){
  const fields = []; const values = []; let i = 1;
  for (const key of ['kk','trophies','wins','losses','kills','games','unlocked','levels','selected','daily_last']) {
    if (data[key] !== undefined) { fields.push(`${key} = $${i}`); values.push(data[key]); i++; }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  values.push(nickname);
  const r = await pool.query(`UPDATE players SET ${fields.join(', ')} WHERE nickname = $${i} RETURNING nickname, kk, trophies, wins, losses, kills, games, unlocked, levels, selected, daily_last`, values);
  return r.rows[0] || null;
}

async function leaderboard(limit = 20){
  const r = await pool.query('SELECT nickname, trophies, wins, losses, kills, games FROM players ORDER BY trophies DESC LIMIT $1', [limit]);
  return r.rows;
}

function pairKey(a, b){ return a < b ? [a, b] : [b, a]; }

async function getFriendsData(nickname){
  const friends = []; const incoming = []; const outgoing = [];
  const r = await pool.query('SELECT player1, player2, status, requested_by FROM friendships WHERE player1 = $1 OR player2 = $1', [nickname]);
  for (const row of r.rows) {
    const other = row.player1 === nickname ? row.player2 : row.player1;
    if (row.status === 'accepted') friends.push({ nickname: other, online: onlineUsers.has(other) });
    else if (row.status === 'pending') {
      if (row.requested_by === nickname) outgoing.push({ nickname: other });
      else incoming.push({ nickname: other });
    }
  }
  return { friends, incoming, outgoing };
}

async function sendFriendRequest(from, to){
  if (from === to) throw new Error('Нельзя добавить себя');
  const target = await pool.query('SELECT nickname FROM players WHERE nickname = $1', [to]);
  if (target.rows.length === 0) throw new Error('Игрок не найден');
  const [a, b] = pairKey(from, to);
  const existing = await pool.query('SELECT * FROM friendships WHERE player1 = $1 AND player2 = $2', [a, b]);
  if (existing.rows.length > 0) {
    if (existing.rows[0].status === 'accepted') throw new Error('Уже в друзьях');
    if (existing.rows[0].status === 'pending') {
      if (existing.rows[0].requested_by === from) throw new Error('Заявка уже отправлена');
      await pool.query('UPDATE friendships SET status = $1 WHERE id = $2', ['accepted', existing.rows[0].id]);
      return { accepted: true };
    }
  }
  await pool.query('INSERT INTO friendships (player1, player2, status, requested_by) VALUES ($1, $2, $3, $4)', [a, b, 'pending', from]);
  return { accepted: false };
}

async function acceptFriendRequest(nickname, other){
  const [a, b] = pairKey(nickname, other);
  const r = await pool.query('SELECT * FROM friendships WHERE player1 = $1 AND player2 = $2 AND status = $3', [a, b, 'pending']);
  if (r.rows.length === 0) throw new Error('Заявка не найдена');
  if (r.rows[0].requested_by === nickname) throw new Error('Это ваша заявка');
  await pool.query('UPDATE friendships SET status = $1 WHERE id = $2', ['accepted', r.rows[0].id]);
  return true;
}

async function removeFriend(nickname, other){
  const [a, b] = pairKey(nickname, other);
  await pool.query('DELETE FROM friendships WHERE player1 = $1 AND player2 = $2', [a, b]);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    console.log(`[${req.method}] ${pathname}`);

    function sendJSON(code, obj){ res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

    if (pathname === '/health') { sendJSON(200, { ok: true, db: dbReady, time: Date.now() }); return; }

    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      try { sendJSON(200, { ok: true, rows: await leaderboard(20) }); }
      catch (e) { sendJSON(500, { ok: false, error: e.message }); }
      return;
    }

    if (pathname === '/api/register' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { nickname, password } = JSON.parse(body);
          if (!nickname || nickname.length < 3 || nickname.length > 16) throw new Error('Ник 3-16 символов');
          if (!/^[a-zA-Z0-9_]+$/.test(nickname)) throw new Error('Ник: буквы, цифры, _');
          if (!password || password.length < 4) throw new Error('Пароль минимум 4 символа');
          if (!dbReady) throw new Error('БД недоступна');
          const token = await registerPlayer(nickname, password);
          const player = await getPlayer(nickname);
          sendJSON(200, { ok: true, token, player });
        } catch (e) { console.error('[register]', e.message); sendJSON(400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { nickname, password } = JSON.parse(body);
          if (!nickname || !password) throw new Error('Заполни все поля');
          if (!dbReady) throw new Error('БД недоступна');
          const token = await loginPlayer(nickname, password);
          const player = await getPlayer(nickname);
          sendJSON(200, { ok: true, token, player });
        } catch (e) { console.error('[login]', e.message); sendJSON(401, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      try { sendJSON(200, { ok: true, player: await getPlayer(nickname) }); }
      catch (e) { sendJSON(500, { ok: false, error: e.message }); }
      return;
    }

    if (pathname === '/api/save' && req.method === 'POST') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const p = await updatePlayer(nickname, data);
          sendJSON(200, { ok: true, player: p });
        } catch (e) { sendJSON(500, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname === '/api/daily' && req.method === 'POST') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      try {
        const p = await getPlayer(nickname);
        const today = new Date().toISOString().slice(0, 10);
        if (p.daily_last === today) { sendJSON(200, { ok: true, claimed: false, player: p }); return; }
        const updated = await updatePlayer(nickname, { kk: p.kk + 100, daily_last: today });
        sendJSON(200, { ok: true, claimed: true, reward: 100, player: updated });
      } catch (e) { sendJSON(500, { ok: false, error: e.message }); }
      return;
    }

    if (pathname === '/api/friends' && req.method === 'GET') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      try { const data = await getFriendsData(nickname); sendJSON(200, { ok: true, ...data }); }
      catch (e) { sendJSON(500, { ok: false, error: e.message }); }
      return;
    }

    if (pathname === '/api/friends/add' && req.method === 'POST') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { friend } = JSON.parse(body);
          if (!friend) throw new Error('Укажи ник');
          const result = await sendFriendRequest(nickname, friend);
          sendJSON(200, { ok: true, ...result });
        } catch (e) { sendJSON(400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname === '/api/friends/accept' && req.method === 'POST') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { friend } = JSON.parse(body);
          await acceptFriendRequest(nickname, friend);
          sendJSON(200, { ok: true });
        } catch (e) { sendJSON(400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname === '/api/friends/remove' && req.method === 'POST') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      let body = ''; req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { friend } = JSON.parse(body);
          await removeFriend(nickname, friend);
          sendJSON(200, { ok: true });
        } catch (e) { sendJSON(400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname === '/api/friends/invite' && req.method === 'POST') {
      const nickname = authByToken(req.headers['x-token']);
      if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { friend, roomId } = JSON.parse(body);
          const sockets = onlineUsers.get(friend);
          if (sockets) for (const s of sockets) send(s, { type: 'friend-invite', from: nickname, roomId });
          sendJSON(200, { ok: true, delivered: !!sockets });
        } catch (e) { sendJSON(400, { ok: false, error: e.message }); }
      });
      return;
    }

    if (pathname.startsWith('/api/')) { sendJSON(404, { ok: false, error: 'API route not found' }); return; }

    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error('[server]', e.message);
    try { res.writeHead(500); res.end('Server error'); } catch(_){}
  }
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
function genRoomId() { let id = ''; for (let i = 0; i < 6; i++) id += Math.floor(Math.random() * 10); return id; }
function send(ws, data) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(data)); } catch (e) {} } }

wss.on('connection', (ws) => {
  ws.roomId = null; ws.role = null; ws.username = 'Игрок';
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    switch (msg.type) {
      case 'identify': {
        const nick = msg.nickname;
        if (nick) {
          wsNickname.set(ws, nick);
          if (!onlineUsers.has(nick)) onlineUsers.set(nick, new Set());
          onlineUsers.get(nick).add(ws);
          console.log('[online]', nick);
        }
        break;
      }
      case 'create-room': {
        let id = genRoomId();
        while (rooms.has(id)) id = genRoomId();
        rooms.set(id, { host: ws, guest: null });
        ws.roomId = id; ws.role = 'host'; ws.username = msg.username || 'Хост';
        send(ws, { type: 'room-created', roomId: id });
        break;
      }
      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) { send(ws, { type: 'error', message: 'Комната не найдена' }); return; }
        if (room.guest) { send(ws, { type: 'error', message: 'Комната полна' }); return; }
        room.guest = ws; ws.roomId = msg.roomId; ws.role = 'guest'; ws.username = msg.username || 'Гость';
        send(room.host, { type: 'opponent-joined', username: ws.username });
        send(ws, { type: 'joined-room', roomId: msg.roomId, hostUsername: room.host.username });
        break;
      }
      case 'relay': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = ws.role === 'host' ? room.guest : room.host;
        if (target && target.readyState === 1) send(target, { type: 'relay', payload: msg.payload });
        break;
      }
      case 'ping': send(ws, { type: 'pong' }); break;
    }
  });
  ws.on('close', () => {
    const nick = wsNickname.get(ws);
    if (nick) {
      const set = onlineUsers.get(nick);
      if (set) { set.delete(ws); if (set.size === 0) onlineUsers.delete(nick); }
      wsNickname.delete(ws);
    }
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        const other = ws.role === 'host' ? room.guest : room.host;
        if (other && other.readyState === 1) send(other, { type: 'opponent-left' });
        rooms.delete(ws.roomId);
      }
    }
  });
  ws.on('error', (err) => console.error('WS error:', err.message));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Digital Style on port', PORT, '| БД:', dbReady ? 'OK' : 'FAIL');
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err && err.message));