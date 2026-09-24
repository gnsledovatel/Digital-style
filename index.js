/* server.js — Digital Style backend + WebSocket */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please-very-secret';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database('digital_style.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    kk INTEGER DEFAULT 200,
    trophies INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0, games INTEGER DEFAULT 0,
    unlocked TEXT, levels TEXT, selected TEXT, skins TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a INTEGER NOT NULL, b INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(a, b)
  );
`);

const ONLINE = new Map(); // userId -> { ws, nickname }

function auth(req, res, next){
  const token = req.headers['x-token'] || req.query.token;
  if (!token) return res.status(401).json({ ok:false, error:'no token' });
  try { const p = jwt.verify(token, JWT_SECRET); req.userId = p.id; req.nickname = p.nickname; next(); }
  catch(e){ res.status(401).json({ ok:false, error:'bad token' }); }
}
function publicPlayer(row){
  if (!row) return null;
  return {
    id: row.id, nickname: row.nickname,
    kk: row.kk, trophies: row.trophies,
    wins: row.wins, losses: row.losses, kills: row.kills, games: row.games,
    unlocked: safeJson(row.unlocked) || {},
    levels: safeJson(row.levels) || {},
    selected: safeJson(row.selected) || { plant:'plant_0', enemy:'inv_0' },
    skins: safeJson(row.skins) || {}
  };
}
function safeJson(s){ try { return s ? JSON.parse(s) : null; } catch(e){ return null; } }
function jstr(v){ try { return JSON.stringify(v || {}); } catch(e){ return '{}'; } }

app.post('/api/register', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    if (!nickname || !password || nickname.length < 3 || nickname.length > 16) return res.json({ ok:false, error:'bad input' });
    if (!/^[a-zA-Z0-9_]+$/.test(nickname)) return res.json({ ok:false, error:'bad nick' });
    const exists = db.prepare('SELECT id FROM players WHERE nickname = ?').get(nickname);
    if (exists) return res.json({ ok:false, error:'ник занят' });
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO players (nickname,password_hash,unlocked,levels,selected,skins) VALUES (?,?,?,?,?,?)').run(nickname, hash, jstr({plant_0:true,plant_1:true,plant_2:true,inv_0:true}), '{}', jstr({plant:'plant_0',enemy:'inv_0'}), '{}');
    const row = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
    const token = jwt.sign({ id: row.id, nickname: row.nickname }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok:true, token, player: publicPlayer(row) });
  } catch(e){ res.json({ ok:false, error: String(e.message || e) }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    const row = db.prepare('SELECT * FROM players WHERE nickname = ?').get(nickname);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) return res.json({ ok:false, error:'неверный ник или пароль' });
    const token = jwt.sign({ id: row.id, nickname: row.nickname }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok:true, token, player: publicPlayer(row) });
  } catch(e){ res.json({ ok:false, error: String(e.message || e) }); }
});

app.get('/api/me', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(req.userId);
  if (!row) return res.status(401).json({ ok:false });
  res.json({ ok:true, player: publicPlayer(row) });
});

app.post('/api/save', auth, (req, res) => {
  try {
    const b = req.body || {};
    db.prepare(`UPDATE players SET kk=?, trophies=?, wins=?, losses=?, kills=?, games=?, unlocked=?, levels=?, selected=?, skins=? WHERE id=?`)
      .run(
        Math.max(0, b.kk|0), Math.max(0, b.trophies|0),
        Math.max(0, b.wins|0), Math.max(0, b.losses|0),
        Math.max(0, b.kills|0), Math.max(0, b.games|0),
        jstr(b.unlocked), jstr(b.levels), jstr(b.selected), jstr(b.skins),
        req.userId
      );
    res.json({ ok:true });
  } catch(e){ res.json({ ok:false, error: String(e.message||e) }); }
});

app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare('SELECT nickname, trophies, wins, losses FROM players ORDER BY trophies DESC LIMIT 50').all();
  res.json({ ok:true, rows });
});

/* ---- friends ---- */
app.get('/api/friends', auth, (req, res) => {
  const uid = req.userId;
  const rows = db.prepare(`SELECT f.id, f.a, f.b, f.status, p.id AS pid, p.nickname, p.trophies
    FROM friends f
    JOIN players p ON (p.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END)
    WHERE f.a = ? OR f.b = ?`).all(uid, uid, uid);
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows){
    const isA = r.a === uid;
    const otherNick = r.nickname;
    const otherOnline = !!ONLINE.get(r.pid);
    const stat = { nickname: otherNick, online: otherOnline, trophies: r.trophies||0 };
    if (r.status === 'accepted') friends.push(stat);
    else if (r.status === 'pending' && isA) outgoing.push({ nickname: otherNick, online: otherOnline });
    else if (r.status === 'pending' && !isA) incoming.push({ nickname: otherNick, online: otherOnline });
  }
  res.json({ ok:true, friends, incoming, outgoing });
});

app.post('/api/friends/add', auth, (req, res) => {
  const { friend } = req.body || {};
  if (!friend) return res.json({ ok:false, error:'no friend' });
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(req.userId);
  const other = db.prepare('SELECT * FROM players WHERE nickname = ?').get(friend);
  if (!other) return res.json({ ok:false, error:'игрок не найден' });
  if (other.id === me.id) return res.json({ ok:false, error:'нельзя себя' });
  const existing = db.prepare('SELECT * FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').get(me.id, other.id, other.id, me.id);
  if (existing){
    if (existing.status === 'pending' && existing.b === me.id){
      db.prepare('UPDATE friends SET status=? WHERE id=?').run('accepted', existing.id);
      return res.json({ ok:true, accepted:true });
    }
    return res.json({ ok:false, error:'уже существует' });
  }
  db.prepare('INSERT INTO friends (a,b,status) VALUES (?,?,?)').run(me.id, other.id, 'pending');
  const otherWs = ONLINE.get(other.id);
  if (otherWs && otherWs.ws.readyState === 1){
    otherWs.ws.send(JSON.stringify({ type:'friend-request', from: me.nickname }));
  }
  res.json({ ok:true });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const { friend } = req.body || {};
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(req.userId);
  const other = db.prepare('SELECT * FROM players WHERE nickname = ?').get(friend);
  if (!other) return res.json({ ok:false, error:'не найден' });
  const row = db.prepare('SELECT * FROM friends WHERE a=? AND b=? AND status=?').get(other.id, me.id, 'pending');
  if (!row) return res.json({ ok:false, error:'нет запроса' });
  db.prepare('UPDATE friends SET status=? WHERE id=?').run('accepted', row.id);
  res.json({ ok:true });
});

app.post('/api/friends/remove', auth, (req, res) => {
  const { friend } = req.body || {};
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(req.userId);
  const other = db.prepare('SELECT * FROM players WHERE nickname = ?').get(friend);
  if (!other) return res.json({ ok:false });
  db.prepare('DELETE FROM friends WHERE (a=? AND b=?) OR (b=? AND a=?)').run(me.id, other.id, me.id, other.id);
  res.json({ ok:true });
});

/* ---- HTTP server + WS ---- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const ROOMS = new Map(); // roomId -> { id, a: userId, b: userId, aNick, bNick }

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws'){ socket.destroy(); return; }
  const token = url.searchParams.get('token');
  if (!token){ socket.destroy(); return; }
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch(e){ socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = payload.id;
    ws.nickname = payload.nickname;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ONLINE.set(ws.userId, { ws, nickname: ws.nickname });
  ws.send(JSON.stringify({ type:'hello', userId: ws.userId, nickname: ws.nickname }));

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch(e){ return; }
    if (!msg || !msg.type) return;

    switch (msg.type){
      case 'ping': ws.send(JSON.stringify({ type:'pong' })); break;

      case 'invite': {
        const target = findUserByNickname(msg.to);
        if (!target || target.userId === ws.userId){ ws.send(JSON.stringify({ type:'invite-error', error:'игрок не найден' })); return; }
        if (!areFriends(ws.userId, target.userId)){ ws.send(JSON.stringify({ type:'invite-error', error:'только друзьям' })); return; }
        const roomId = crypto.randomBytes(6).toString('hex');
        ROOMS.set(roomId, { id: roomId, a: ws.userId, b: target.userId, aNick: ws.nickname, bNick: target.nickname });
        target.ws.send(JSON.stringify({ type:'friend-invite', from: ws.nickname, roomId }));
        ws.send(JSON.stringify({ type:'invite-sent', to: target.nickname, roomId }));
        break;
      }
      case 'invite-accept': {
        const room = ROOMS.get(msg.roomId);
        if (!room){ ws.send(JSON.stringify({ type:'invite-error', error:'комната истекла' })); return; }
        const aWs = ONLINE.get(room.a)?.ws;
        if (aWs && aWs.readyState === 1){
          aWs.send(JSON.stringify({ type:'room-joined', roomId: room.id, opponent: ws.nickname, host: true }));
        }
        ws.send(JSON.stringify({ type:'room-joined', roomId: room.id, opponent: room.aNick, host: false }));
        break;
      }
      case 'invite-decline': {
        const room = ROOMS.get(msg.roomId);
        if (room){
          const aWs = ONLINE.get(room.a)?.ws;
          if (aWs && aWs.readyState === 1){
            aWs.send(JSON.stringify({ type:'invite-declined', from: ws.nickname }));
          }
          ROOMS.delete(room.id);
        }
        break;
      }
      case 'invite-cancel': {
        const target = findUserByNickname(msg.to);
        if (target && target.ws.readyState === 1){
          target.ws.send(JSON.stringify({ type:'invite-cancelled', from: ws.nickname }));
        }
        for (const [rid, room] of ROOMS){ if (room.a === ws.userId) ROOMS.delete(rid); }
        break;
      }
      case 'leave':
      case 'match-end': {
        for (const [rid, room] of ROOMS){
          if (room.a === ws.userId || room.b === ws.userId){
            const otherId = room.a === ws.userId ? room.b : room.a;
            const otherWs = ONLINE.get(otherId)?.ws;
            if (otherWs && otherWs.readyState === 1 && msg.type === 'leave'){
              otherWs.send(JSON.stringify({ type:'room-left' }));
            }
            if (msg.type === 'match-end') ROOMS.delete(rid);
          }
        }
        break;
      }
      case 'player-info': {
        const peer = peerOf(ws.userId);
        if (peer && peer.readyState === 1){
          peer.send(JSON.stringify({ type:'opp-info', fighterId: msg.fighterId, skin: msg.skin }));
        }
        break;
      }
      case 'state': {
        const peer = peerOf(ws.userId);
        if (peer && peer.readyState === 1){
          peer.send(JSON.stringify({ type:'opp-state', x: msg.x, z: msg.z, hp: msg.hp, yaw: msg.yaw, walkPhase: msg.walkPhase, dead: msg.dead }));
        }
        break;
      }
      case 'shot': {
        const peer = peerOf(ws.userId);
        if (peer && peer.readyState === 1){
          peer.send(JSON.stringify({ type:'opp-shot', x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz, attack: msg.attack, dmg: msg.dmg }));
        }
        break;
      }
      case 'hit': {
        const peer = peerOf(ws.userId);
        if (peer && peer.readyState === 1){
          peer.send(JSON.stringify({ type:'opp-hit', dmg: msg.dmg }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    ONLINE.delete(ws.userId);
    for (const [rid, room] of ROOMS){
      if (room.a === ws.userId || room.b === ws.userId){
        const otherId = room.a === ws.userId ? room.b : room.a;
        const otherWs = ONLINE.get(otherId)?.ws;
        if (otherWs && otherWs.readyState === 1){
          otherWs.send(JSON.stringify({ type:'room-left' }));
        }
        ROOMS.delete(rid);
      }
    }
  });
});

function findUserByNickname(nick){
  for (const [uid, entry] of ONLINE){
    if (entry.nickname === nick) return { userId: uid, ws: entry.ws };
  }
  return null;
}
function areFriends(a, b){
  const row = db.prepare('SELECT status FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').get(a, b, b, a);
  return !!(row && row.status === 'accepted');
}
function peerOf(userId){
  for (const [, room] of ROOMS){
    if (room.a === userId) return ONLINE.get(room.b)?.ws || null;
    if (room.b === userId) return ONLINE.get(room.a)?.ws || null;
  }
  return null;
}

server.listen(PORT, () => console.log('Digital Style server on :' + PORT));