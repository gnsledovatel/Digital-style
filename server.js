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

/* ============ POSTGRESQL ============ */
let pool = null;
let dbReady = false;
const sessions = new Map(); // token -> { nickname, expires }

if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  initDB().catch(err => console.error('DB init error:', err.message));
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
    );
    CREATE INDEX IF NOT EXISTS idx_trophies ON players(trophies DESC);
  `);
  await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS password_salt TEXT');
  dbReady = true;
  console.log('✅ БД готова');
}

/* ============ АВТОРИЗАЦИЯ ============ */
function hashPassword(password, salt){
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function genSalt(){ return crypto.randomBytes(16).toString('hex'); }
function genToken(){ return crypto.randomBytes(32).toString('hex'); }

async function registerPlayer(nickname, password){
  const existing = await pool.query('SELECT id FROM players WHERE nickname = $1', [nickname]);
  if (existing.rows.length > 0) {
    const p = existing.rows[0];
    const full = await pool.query('SELECT password_hash FROM players WHERE id = $1', [p.id]);
    if (full.rows[0].password_hash) throw new Error('Ник занят');
    // старый аккаунт без пароля — «присваиваем» пароль
    const salt = genSalt();
    const hash = hashPassword(password, salt);
    await pool.query('UPDATE players SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt, p.id]);
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
  if (!p.password_hash) throw new Error('Аккаунт без пароля. Зарегистрируйся заново');
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
  const fields = [];
  const values = [];
  let i = 1;
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

/* ============ HTTP ============ */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  function sendJSON(code, obj){ res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

  if (pathname === '/health') { sendJSON(200, { ok: true, db: dbReady, time: Date.now() }); return; }

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    try { sendJSON(200, { ok: true, rows: await leaderboard(20) }); }
    catch (e) { sendJSON(500, { ok: false, error: e.message }); }
    return;
  }

  // ====== РЕГИСТРАЦИЯ ======
  if (pathname === '/api/register' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { nickname, password } = JSON.parse(body);
        if (!nickname || nickname.length < 3 || nickname.length > 16) throw new Error('Ник 3-16 символов');
        if (!/^[a-zA-Z0-9_]+$/.test(nickname)) throw new Error('Ник: только буквы, цифры, _');
        if (!password || password.length < 4) throw new Error('Пароль минимум 4 символа');
        const token = await registerPlayer(nickname, password);
        const player = await getPlayer(nickname);
        sendJSON(200, { ok: true, token, player });
      } catch (e) { sendJSON(400, { ok: false, error: e.message }); }
    });
    return;
  }

  // ====== ВХОД ======
  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { nickname, password } = JSON.parse(body);
        if (!nickname || !password) throw new Error('Заполни все поля');
        const token = await loginPlayer(nickname, password);
        const player = await getPlayer(nickname);
        sendJSON(200, { ok: true, token, player });
      } catch (e) { sendJSON(401, { ok: false, error: e.message }); }
    });
    return;
  }

  // ====== ПРОФИЛЬ ПО ТОКЕНУ ======
  if (pathname === '/api/me' && req.method === 'GET') {
    const nickname = authByToken(req.headers['x-token']);
    if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
    try { sendJSON(200, { ok: true, player: await getPlayer(nickname) }); }
    catch (e) { sendJSON(500, { ok: false, error: e.message }); }
    return;
  }

  // ====== СОХРАНЕНИЕ ======
  if (pathname === '/api/save' && req.method === 'POST') {
    const nickname = authByToken(req.headers['x-token']);
    if (!nickname) { sendJSON(401, { ok: false, error: 'Не авторизован' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const p = await updatePlayer(nickname, data);
        sendJSON(200, { ok: true, player: p });
      } catch (e) { sendJSON(500, { ok: false, error: e.message }); }
    });
    return;
  }

  // ====== ЕЖЕДНЕВКА ======
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

  // ====== СТАТИКА ======
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

/* ============ WEBSOCKET ============ */
const wss = new WebSocketServer({ server });
const rooms = new Map();
function genRoomId() { let id = ''; for (let i = 0; i < 6; i++) id += Math.floor(Math.random() * 10); return id; }
function send(ws, data) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(data)); } catch (e) {} } }

wss.on('connection', (ws) => {
  ws.roomId = null; ws.role = null; ws.username = 'Игрок';
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    switch (msg.type) {
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