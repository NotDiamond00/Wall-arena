import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/rooms.js';

const tk = i => 't' + i;
let n = 0;
const id = () => 'a' + n++;
const wait = ms => new Promise(r => setTimeout(r, ms));
function setup(opts = {}) {
  const views = new Map();
  const hub = new Hub((t, ev, d) => { if (ev === 'room') views.set(t, d); }, { startDelay: 20, ...opts });
  return { hub, views };
}
const same = (a, b) => assert.deepEqual({ ...a, you: 0 }, { ...b, you: 0 });

test('1v1 private room: codes, ready-up, sync, turn order, duplicate + stale rejection', () => {
  const { hub, views } = setup();
  const code = hub.create(tk(1), 'Ann', { mode: '1v1', size: 10 });
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.throws(() => hub.join(tk(2), 'Bob', 'ZZZZZ'), /room not found/);
  hub.join(tk(2), 'Bob', code.toLowerCase());
  hub.ready(tk(1), true);
  assert.equal(views.get(tk(1)).status, 'lobby');
  hub.ready(tk(2), true);
  const a = views.get(tk(1)), b = views.get(tk(2));
  assert.equal(a.status, 'playing');
  assert.deepEqual([a.you, b.you], [0, 1]);
  same(a, b);
  const [x, y] = a.legal[0], aid = id();
  assert.throws(() => hub.act(tk(2), { id: id(), v: 0, t: 'move', x: 0, y: 0 }), /not your turn/);
  hub.act(tk(1), { id: aid, v: 0, t: 'move', x, y });
  assert.equal(views.get(tk(2)).turn, 1);
  assert.equal(views.get(tk(2)).players[0].x, x);
  same(views.get(tk(1)), views.get(tk(2)));
  assert.throws(() => hub.act(tk(1), { id: aid, v: 1, t: 'move', x, y }), /duplicate/);
  assert.throws(() => hub.act(tk(2), { id: id(), v: 0, t: 'wall', o: 'h', x: 1, y: 1 }), /stale/);
  hub.act(tk(2), { id: id(), v: 1, t: 'wall', o: 'h', x: 1, y: 1 });
  assert.equal(views.get(tk(1)).players[1].walls, 9);
  assert.equal(views.get(tk(2)).hw.length, 1);
  hub.close();
});

for (const [mode, count, teams] of [['1v2', 3, [0, 1, 1]], ['1v3', 4, [0, 1, 1, 1]], ['ffa', 4, [0, 1, 2, 3]]]) {
  test(`${mode}: ${count} real players start, stay in sync, room is capped`, () => {
    const { hub, views } = setup();
    const code = hub.create(tk(1), 'P1', { mode, size: 20 });
    for (let i = 2; i <= count; i++) hub.join(tk(i), 'P' + i, code);
    assert.throws(() => hub.join(tk(9), 'X', code), /room full/);
    for (let i = 1; i <= count; i++) hub.ready(tk(i), true);
    const v = views.get(tk(1));
    assert.equal(v.status, 'playing');
    assert.equal(v.players.length, count);
    assert.ok(v.players.every(p => p.walls === 40)); // floor(20*20/10)
    assert.deepEqual(v.players.map(p => p.team), teams);
    for (let r = 0; r < count; r++) {
      const cur = views.get(tk(1)), [x, y] = cur.legal[0];
      hub.act(tk(cur.turn + 1), { id: id(), v: cur.version, t: 'move', x, y });
    }
    const all = Array.from({ length: count }, (_, i) => views.get(tk(i + 1)));
    all.forEach(w => same(w, all[0]));
    hub.close();
  });
}

test('free-for-all starts with 3 players after the join window', async () => {
  const { hub, views } = setup();
  const code = hub.create(tk(1), 'A', { mode: 'ffa', size: 10 });
  hub.join(tk(2), 'B', code); hub.join(tk(3), 'C', code);
  [1, 2, 3].forEach(i => hub.ready(tk(i), true));
  assert.equal(views.get(tk(1)).status, 'lobby');
  assert.equal(views.get(tk(1)).countdown, true);
  await wait(80);
  assert.equal(views.get(tk(1)).status, 'playing');
  assert.equal(views.get(tk(3)).players.length, 3);
  hub.close();
});

test('quick match pairs players by mode and size', () => {
  const { hub, views } = setup();
  hub.quick(tk(1), 'A', { mode: '1v1', size: 30 });
  assert.equal(views.get(tk(1)).status, 'lobby');
  hub.quick(tk(2), 'B', { mode: '1v1', size: 30 });
  assert.equal(views.get(tk(1)).code, views.get(tk(2)).code);
  assert.equal(views.get(tk(2)).status, 'playing');
  hub.quick(tk(3), 'C', { mode: '1v1', size: 30 });
  assert.notEqual(views.get(tk(3)).code, views.get(tk(1)).code);
  assert.throws(() => hub.quick(tk(4), 'D', { mode: '1v1', size: 60 }), /bad board size/);
  hub.close();
});

test('reconnect restores state; offline turns are auto-played', async () => {
  const { hub, views } = setup({ idleMs: 10 });
  const code = hub.create(tk(1), 'A', { mode: '1v1', size: 10 });
  hub.join(tk(2), 'B', code); hub.ready(tk(1), true); hub.ready(tk(2), true);
  hub.online(tk(2), false);
  assert.equal(views.get(tk(1)).players[1].on, false);
  const [x, y] = views.get(tk(1)).legal[0];
  hub.act(tk(1), { id: id(), v: 0, t: 'move', x, y });
  await wait(80);
  assert.ok(views.get(tk(1)).version >= 2);
  hub.resume(tk(2));
  assert.equal(views.get(tk(2)).players[1].on, true);
  assert.equal(views.get(tk(2)).you, 1);
  same(views.get(tk(1)), views.get(tk(2)));
  hub.close();
});

test('expired turns are auto-played; 3 misses in a row forfeit', () => {
  const { hub, views } = setup();
  const code = hub.create(tk(1), 'A', { mode: '1v1', size: 10 });
  hub.join(tk(2), 'B', code); hub.ready(tk(1), true); hub.ready(tk(2), true);
  const room = hub.rooms.get(code);
  hub.expire(room);
  assert.equal(views.get(tk(2)).version, 1);
  for (let i = 0; i < 4; i++) hub.expire(room);
  assert.equal(views.get(tk(2)).status, 'over');
  assert.equal(views.get(tk(2)).winner, 1);
  hub.close();
});

test('leaving mid-match forfeits; rematch returns both players to a new game', () => {
  const { hub, views } = setup();
  let code = hub.create(tk(1), 'A', { mode: '1v1', size: 10 });
  hub.join(tk(2), 'B', code); hub.ready(tk(1), true); hub.ready(tk(2), true);
  hub.leave(tk(2));
  assert.equal(views.get(tk(1)).status, 'over');
  assert.equal(views.get(tk(1)).winner, 0);
  hub.close();

  code = hub.create(tk(3), 'C', { mode: '1v1', size: 10 });
  hub.join(tk(4), 'D', code); hub.ready(tk(3), true); hub.ready(tk(4), true);
  const room = hub.rooms.get(code);
  hub.leave(tk(4)); hub.close();
  assert.equal(room.status, 'over');
});

test('rematch after a finished game', () => {
  const { hub, views } = setup();
  const code = hub.create(tk(1), 'A', { mode: '1v1', size: 10 });
  hub.join(tk(2), 'B', code); hub.ready(tk(1), true); hub.ready(tk(2), true);
  const room = hub.rooms.get(code);
  for (let i = 0; i < 5; i++) hub.expire(room); // seat 0 forfeits after 3 misses
  assert.equal(views.get(tk(1)).status, 'over');
  hub.rematch(tk(1));
  assert.equal(views.get(tk(1)).status, 'over');
  hub.rematch(tk(2));
  assert.equal(views.get(tk(1)).status, 'playing');
  assert.equal(views.get(tk(1)).version, 0);
  assert.ok(views.get(tk(1)).players.every(p => p.walls === 10));
  hub.close();
});
