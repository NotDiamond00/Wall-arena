import express from 'express';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { Hub } from './src/rooms.js';

const PORT = process.env.PORT || 3000;
const origins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: origins ? { origin: origins } : undefined, maxHttpBufferSize: 1e4 });
const socks = new Map(); // player token -> current socket
const hub = new Hub((tok, ev, d) => socks.get(tok)?.emit(ev, d));

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, rooms: hub.rooms.size, uptime: Math.round(process.uptime()) }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

io.on('connection', socket => {
  let tok = null, hits = [];
  // Every event: rate-limited (40 / 5 s), must follow `hello`, payload must be an object; hub errors go back as 'err'.
  const on = (ev, fn) => socket.on(ev, d => {
    const t = Date.now();
    hits = hits.filter(h => t - h < 5000);
    if (hits.push(t) > 40) return socket.emit('err', 'Slow down');
    try {
      if (ev !== 'hello' && !tok) throw new Error('say hello first');
      fn(d && typeof d === 'object' ? d : {});
    } catch (e) { socket.emit('err', e.message); }
  });

  on('hello', d => {
    if (!/^[a-f0-9]{32}$/.test(d.token)) throw new Error('bad token');
    tok = d.token; socks.set(tok, socket); hub.resume(tok); // reconnects land back in their room
  });
  on('quick', d => hub.quick(tok, d.name, { mode: d.mode, size: d.size }));
  on('create', d => hub.create(tok, d.name, { mode: d.mode, size: d.size, turnSec: d.turnSec }));
  on('join', d => hub.join(tok, d.name, d.code));
  on('ready', d => hub.ready(tok, d.v));
  on('act', d => hub.act(tok, d));
  on('rematch', () => hub.rematch(tok));
  on('leave', () => hub.leave(tok));
  socket.on('disconnect', () => {
    if (tok && socks.get(tok) === socket) { socks.delete(tok); hub.online(tok, false); }
  });
});

server.listen(PORT, () => console.log(`WALL ARENA listening on :${PORT}`));
