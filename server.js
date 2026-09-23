import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* ============ POSTGRESQL ============ */
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  initDB().catch(err => console.error('DB init error:', err.message));
} else {
  console.warn('⚠️ DATABASE_URL не задан — работаем без БД');
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
  dbReady = true;
  console.log('✅ БД готова');
}

async function getPlayer(nickname){
  if (!dbReady) return null;
  const r = await pool.query('SELECT * FROM players WHERE nickname = $1', [nickname]);
  return r.rows[0] || null;
}

async function createPlayer(nickname){
  if (!dbReady) return null;
  const r = await pool.query(
    `INSERT INTO players (nickname) VALUES ($1)
     ON CONFLICT (nickname) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [nickname]
  );
  return r.rows[0];
}

async function updatePlayer(nickname, data){
  if (!dbReady) return null;
  const fields = [];
  const values = [];
  let i = 1;
  for (const key of ['kk','trophies','wins','losses','kills','games','unlocked','levels','selected','daily_last']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${i}`);
      values.push(data[key]);
      i++;
    }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  values.push(nickname);
  const r = await pool.query(
    `UPDATE players SET ${fields.join(', ')} WHERE nickname = $${i} RETURNING *`,
    values
  );
  return r.rows[0] || null;
}

async function leaderboard(limit = 20){
  if (!dbReady) return [];
  const r = await pool.query(
    'SELECT nickname, trophies, wins, losses, kills, games FROM players ORDER BY trophies DESC LIMIT $1',
    [limit]
  );
  return r.rows;
}

/* ============ HTTP СЕРВЕР ============ */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ====== API ======
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, db: dbReady, time: Date.now() }));
    return;
  }

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    try {
      const rows = await leaderboard(20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rows }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/player' && req.method === 'GET') {
    const nick = url.searchParams.get('nickname');
    if (!nick) { res.writeHead(400); res.end('{"ok":false,"error":"nickname required"}'); return; }
    try {
      let p = await getPlayer(nick);
      if (!p) p = await createPlayer(nick);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, player: p }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/player' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (!data.nickname) throw new Error('nickname required');
        let p = await getPlayer(data.nickname);
        if (!p) p = await createPlayer(data.nickname);
        if (data.save) p = await updatePlayer(data.nickname, data.save);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, player: p }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/daily' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (!data.nickname) throw new Error('nickname required');
        let p = await getPlayer(data.nickname);
        if (!p) p = await createPlayer(data.nickname);
        const today = new Date().toISOString().slice(0, 10);
        if (p.daily_last === today) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, claimed: false, player: p }));
          return;
        }
        p = await updatePlayer(data.nickname, {
          kk: p.kk + 100,
          daily_last: today
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, claimed: true, reward: 100, player: p }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ====== СТАТИКА ======
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

/* ============ WEBSOCKET ============ */
const wss = new WebSocketServer({ server });

const rooms = new Map();

function generateRoomId() {
  let id = '';
  for (let i = 0; i < 6; i++) id += Math.floor(Math.random() * 10);
  return id;
}

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch (e) {}
  }
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.role = null;
  ws.username = 'Игрок';

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (msg.type) {

      case 'create-room': {
        let id = generateRoomId();
        while (rooms.has(id)) id = generateRoomId();
        rooms.set(id, { host: ws, guest: null });
        ws.roomId = id;
        ws.role = 'host';
        ws.username = msg.username || 'Хост';
        send(ws, { type: 'room-created', roomId: id });
        console.log('[+] Room', id, 'created');
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) { send(ws, { type: 'error', message: 'Комната не найдена' }); return; }
        if (room.guest) { send(ws, { type: 'error', message: 'Комната полна' }); return; }
        room.guest = ws;
        ws.roomId = msg.roomId;
        ws.role = 'guest';
        ws.username = msg.username || 'Гость';
        send(room.host, { type: 'opponent-joined', username: ws.username });
        send(ws, { type: 'joined-room', roomId: msg.roomId, hostUsername: room.host.username });
        console.log('[+] Guest joined room', msg.roomId);
        break;
      }

      case 'relay': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = ws.role === 'host' ? room.guest : room.host;
        if (target && target.readyState === 1) {
          send(target, { type: 'relay', payload: msg.payload });
        }
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        const other = ws.role === 'host' ? room.guest : room.host;
        if (other && other.readyState === 1) send(other, { type: 'opponent-left' });
        rooms.delete(ws.roomId);
        console.log('[-] Room', ws.roomId, 'closed');
      }
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

/* ============ ЗАПУСК ============ */
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Digital Style server started on port', PORT);
  console.log('📊 БД:', dbReady ? 'подключена' : 'НЕ подключена');
});