// Rooms, matchmaking, turn timers, reconnection. Token-based and transport-agnostic:
// emit(token, event, data) delivers a message to one player. Every method throws Error(message) on invalid input.
import { randomInt } from 'node:crypto';
import * as R from './rules.js';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const clean = s => String(s ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 16) || 'Guest';
const fail = m => { throw new Error(m); };
const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
const check = (mode, size) => {
  if (!Object.hasOwn(R.MODES, mode)) fail('bad mode');
  if (!R.SIZES.includes(size)) fail('bad board size');
};

export class Hub {
  constructor(emit, opts = {}) {
    Object.assign(this, { emit, rooms: new Map(), of: new Map(), grace: 30000, idleMs: 1200, startDelay: 5000 }, opts);
  }

  create(tok, name, { mode = '1v1', size = 10, turnSec = 30, pub = false } = {}) {
    check(mode, size);
    if (![15, 30, 60, 90].includes(turnSec)) fail('bad turn timer');
    this.leave(tok);
    let code;
    do code = Array.from({ length: 5 }, () => ALPHA[randomInt(ALPHA.length)]).join(''); while (this.rooms.has(code));
    const room = { code, mode, size, turnSec, pub, players: [], status: 'lobby', g: null, seen: new Set(), votes: new Set(),
      timer: null, start: null, gc: null, deadline: 0, startedAt: 0, endedAt: 0 };
    this.rooms.set(code, room);
    this.add(room, tok, name);
    return code;
  }

  add(room, tok, name, ready = false) {
    room.players.push({ tok, name: clean(name), ready, on: true, misses: 0, left: false, dc: null });
    this.of.set(tok, room);
    this.maybeStart(room); this.push(room);
  }

  // Public queue: join an open public lobby with the same mode + size, else open one. Quick-match players are auto-ready.
  quick(tok, name, { mode = '1v1', size = 10 } = {}) {
    check(mode, size);
    const room = [...this.rooms.values()].find(r => r.pub && r.status === 'lobby' && r.mode === mode && r.size === size
      && r.players.length < R.MODES[mode].cap && !r.players.some(p => p.tok === tok));
    if (room) { this.leave(tok); this.add(room, tok, name, true); }
    else { this.create(tok, name, { mode, size, pub: true }); this.ready(tok, true); }
  }

  join(tok, name, code) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) fail('room not found');
    if (this.of.get(tok) === room) return this.resume(tok);
    if (room.status !== 'lobby') fail('match already started');
    if (room.players.length >= R.MODES[room.mode].cap) fail('room full');
    this.leave(tok);
    this.add(room, tok, name);
  }

  ready(tok, v) {
    const room = this.of.get(tok);
    if (!room || room.status !== 'lobby') fail('not in a lobby');
    room.players.find(p => p.tok === tok).ready = !!v;
    this.maybeStart(room); this.push(room);
  }

  canStart(room) {
    return room.status === 'lobby' && room.players.length >= R.MODES[room.mode].min && room.players.every(p => p.ready);
  }

  // Full room starts at once; a partly filled free-for-all (3 of 4) waits startDelay ms for a 4th player.
  maybeStart(room) {
    if (!this.canStart(room)) { clearTimeout(room.start); room.start = null; return; }
    if (room.players.length === R.MODES[room.mode].cap) return this.begin(room);
    if (!room.start) room.start = later(() => { room.start = null; if (this.canStart(room)) this.begin(room); }, this.startDelay);
  }

  begin(room) {
    clearTimeout(room.start); room.start = null;
    room.g = R.newGame(room.mode, room.size, room.players.length);
    Object.assign(room, { status: 'playing', startedAt: Date.now(), endedAt: 0 });
    room.seen.clear(); room.votes.clear();
    room.players.forEach(p => { p.misses = 0; });
    this.tick(room);
  }

  tick(room) {
    clearTimeout(room.timer);
    if (room.status === 'playing') {
      const ms = room.players[room.g.turn].on ? room.turnSec * 1000 : this.idleMs; // absent players are auto-played quickly
      room.deadline = Date.now() + ms;
      room.timer = later(() => this.expire(room), ms);
    }
    this.push(room);
  }

  after(room) { if (room.g.winner !== null) this.finish(room); else this.tick(room); }

  finish(room) {
    clearTimeout(room.timer);
    Object.assign(room, { status: 'over', endedAt: Date.now() });
    room.votes.clear(); this.push(room);
  }

  // Turn timer ran out (or the player is offline): play the best legal step; 3 misses in a row forfeit.
  expire(room) {
    if (room.status !== 'playing') return;
    const g = room.g, s = g.turn, p = room.players[s];
    p.misses++;
    R.act(g, s, R.autoMove(g, s));
    if (g.winner === null && p.misses >= 3) R.forfeit(g, s);
    this.after(room);
  }

  act(tok, a) {
    const room = this.of.get(tok);
    if (!room || room.status !== 'playing') fail('no active match');
    const s = room.players.findIndex(p => p.tok === tok), g = room.g;
    if (typeof a.id !== 'string' || a.id.length > 40) fail('bad action id');
    if (room.seen.has(a.id)) fail('duplicate action');
    if (a.v !== g.version) fail('stale state');
    room.seen.add(a.id);
    if (room.seen.size > 200) room.seen.delete(room.seen.values().next().value);
    const e = R.act(g, s, a);
    if (e) fail(e);
    room.players[s].misses = 0;
    this.after(room);
  }

  leave(tok) {
    const room = this.of.get(tok);
    if (!room) return;
    this.of.delete(tok); this.emit(tok, 'room', null);
    const s = room.players.findIndex(p => p.tok === tok), p = room.players[s];
    if (room.status === 'lobby') { clearTimeout(p.dc); room.players.splice(s, 1); }
    else { p.left = true; p.on = false; if (room.status === 'playing') { R.forfeit(room.g, s); this.after(room); } }
    if (room.players.every(q => q.left)) return this.drop(room);
    if (room.status === 'lobby') this.maybeStart(room);
    this.push(room);
  }

  rematch(tok) {
    const room = this.of.get(tok);
    if (!room || room.status !== 'over') fail('no finished match');
    room.votes.add(tok);
    if (room.players.filter(p => !p.left).every(p => room.votes.has(p.tok))) {
      room.players = room.players.filter(p => !p.left);
      room.players.forEach(p => { p.ready = true; p.misses = 0; });
      Object.assign(room, { status: 'lobby', g: null, deadline: 0 });
      room.votes.clear(); this.maybeStart(room);
    }
    this.push(room);
  }

  // Connection presence. Lobby seats are released after `grace` ms offline; in a match the player's turns are auto-played.
  online(tok, on) {
    const room = this.of.get(tok), p = room?.players.find(q => q.tok === tok);
    if (!p || p.left) return;
    p.on = on; clearTimeout(p.dc); clearTimeout(room.gc);
    if (!on && room.status === 'lobby') p.dc = later(() => this.leave(tok), this.grace);
    if (!room.players.some(q => q.on && !q.left)) room.gc = later(() => this.drop(room), 600000);
    this.push(room);
  }

  resume(tok) { if (this.of.has(tok)) this.online(tok, true); else this.emit(tok, 'room', null); }

  drop(room) {
    for (const t of [room.timer, room.start, room.gc, ...room.players.map(p => p.dc)]) clearTimeout(t);
    room.players.forEach(p => { if (this.of.get(p.tok) === room) this.of.delete(p.tok); });
    this.rooms.delete(room.code);
  }

  close() { [...this.rooms.values()].forEach(r => this.drop(r)); }

  view(room) {
    const g = room.g;
    return {
      code: room.code, mode: room.mode, size: room.size, turnSec: room.turnSec, pub: room.pub, status: room.status,
      countdown: !!room.start, now: Date.now(), startedAt: room.startedAt, endedAt: room.endedAt, deadline: room.deadline,
      wallsPer: R.wallsFor(room.size), version: g ? g.version : 0, turn: g ? g.turn : -1, winner: g ? g.winner : null,
      hw: g ? [...g.hw] : [], vw: g ? [...g.vw] : [], // wall keys: x = k >> 6, y = k & 63
      legal: g && g.winner === null ? R.legalMoves(g, g.turn) : [], votes: room.votes.size,
      players: room.players.map((p, i) => ({
        seat: i, name: p.name, color: R.COLORS[i], team: R.teamOf(room.mode, i), ready: p.ready, on: p.on, left: p.left,
        ...(g ? { x: g.players[i].x, y: g.players[i].y, walls: g.players[i].walls, alive: g.players[i].alive } : {}),
      })),
    };
  }

  push(room) {
    const v = this.view(room);
    room.players.forEach((p, i) => { if (!p.left) this.emit(p.tok, 'room', { ...v, you: i }); });
  }
}
