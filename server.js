import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* ============ HTTP СЕРВЕР (раздаёт index.html) ============ */
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, time: Date.now() }));
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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

const rooms = new Map(); // roomId -> { host, guest }

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
        if (!room) {
          send(ws, { type: 'error', message: 'Комната не найдена' });
          return;
        }
        if (room.guest) {
          send(ws, { type: 'error', message: 'Комната полна' });
          return;
        }
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
        if (other && other.readyState === 1) {
          send(other, { type: 'opponent-left' });
        }
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
});

/* ============ АНТИ-СОН (для бесплатных хостингов) ============ */
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(SELF_URL + '/health')
    .then(() => console.log('[keep-alive] OK'))
    .catch(err => console.log('[keep-alive] error:', err.message));
}, 10 * 60 * 1000);