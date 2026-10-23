import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';

const mv = (g, s, x, y) => R.act(g, s, { t: 'move', x, y });
const wall = (g, s, o, x, y) => { g.turn = s; return R.act(g, s, { t: 'wall', o, x, y }); };
const cells = m => m.map(c => c.join(',')).sort();

test('wall counts follow floor(n²/10) for every board size', () => {
  assert.deepEqual(R.SIZES.map(R.wallsFor), [10, 40, 90, 160, 250]);
  for (const n of R.SIZES) for (const p of R.newGame('ffa', n, 4).players) assert.equal(p.walls, Math.floor((n * n) / 10));
});

test('start positions are on-board, distinct, n-1 steps from goal, with 3 opening moves', () => {
  for (const n of R.SIZES) for (const c of [2, 3, 4]) {
    const g = R.newGame('ffa', n, c);
    assert.equal(new Set(g.players.map(p => p.x + ',' + p.y)).size, c);
    for (const p of g.players) {
      assert.ok(p.x >= 0 && p.y >= 0 && p.x < n && p.y < n);
      assert.equal(R.field(g, p.k)[p.y * n + p.x], n - 1);
      assert.equal(R.legalMoves(g, p.seat).length, 3);
    }
  }
});

test('legal movement and horizontal walls blocking it', () => {
  const g = R.newGame('1v1', 10, 2); // blue (5,9), red (4,0)
  assert.deepEqual(cells(R.legalMoves(g, 0)), ['4,9', '5,8', '6,9']);
  assert.equal(wall(g, 0, 'h', 5, 8), null);
  assert.deepEqual(cells(R.legalMoves(g, 0)), ['4,9', '6,9']);
  assert.equal(g.players[0].walls, 9); // deducted only after a successful placement
});

test('vertical walls block horizontal movement', () => {
  const g = R.newGame('1v1', 10, 2);
  assert.equal(wall(g, 0, 'v', 5, 8), null);
  assert.deepEqual(cells(R.legalMoves(g, 0)), ['4,9', '5,8']);
});

test('overlapping, crossing and out-of-bounds walls are rejected', () => {
  const g = R.newGame('1v1', 10, 2);
  assert.equal(wall(g, 0, 'h', 4, 4), null);
  assert.equal(R.wallError(g, 0, 'h', 4, 4), 'wall conflict');
  assert.equal(R.wallError(g, 0, 'v', 4, 4), 'wall conflict'); // crossing
  assert.equal(R.wallError(g, 0, 'h', 5, 4), 'wall overlap');
  assert.equal(R.wallError(g, 0, 'h', 3, 4), 'wall overlap');
  assert.equal(R.wallError(g, 0, 'h', 6, 4), null);
  for (const [x, y] of [[-1, 0], [0, -1], [9, 0], [0, 9], [1.5, 1]]) for (const o of ['h', 'v']) assert.equal(R.wallError(g, 0, o, x, y), 'out of bounds');
  assert.equal(g.players[0].walls, 9);
});

test('a wall that would remove every route is rejected', () => {
  const g = R.newGame('1v1', 10, 2);
  for (const x of [0, 2, 4, 6]) assert.equal(wall(g, 0, 'h', x, 4), null);
  assert.equal(R.wallError(g, 0, 'h', 8, 4), 'blocks all routes');
  assert.equal(g.players[0].walls, 6);
});

test('no walls left means no placement', () => {
  const g = R.newGame('1v1', 10, 2);
  g.players[0].walls = 0;
  assert.equal(wall(g, 0, 'h', 1, 1), 'no walls left');
});

test('turn order is enforced and reaching the goal wins', () => {
  const g = R.newGame('1v1', 10, 2);
  assert.equal(mv(g, 1, 4, 1), 'not your turn');
  assert.equal(mv(g, 0, 9, 9), 'illegal move');
  assert.equal(mv(g, 0, 5, 8), null);
  assert.equal(g.turn, 1);
  g.players[0].y = 1; g.turn = 0;
  assert.equal(mv(g, 0, 5, 0), null);
  assert.equal(g.winner, 0);
  assert.equal(mv(g, 1, 4, 1), 'game over');
});

test('team modes: any teammate reaching the goal wins for the team', () => {
  const g = R.newGame('1v2', 10, 3); // blue alone; red + green are team 1
  assert.deepEqual(g.players.map(p => p.team), [0, 1, 1]);
  Object.assign(g.players[2], { x: 8, y: 3 }); g.turn = 2;
  assert.equal(mv(g, 2, 9, 3), null);
  assert.equal(g.winner, 1);
});

test('jumps over adjacent tokens and sidesteps when the jump is blocked', () => {
  const g = R.newGame('1v1', 10, 2);
  Object.assign(g.players[1], { x: 5, y: 8 }); // red directly in front of blue
  assert.deepEqual(cells(R.legalMoves(g, 0)), ['4,9', '5,7', '6,9']);
  assert.equal(wall(g, 0, 'h', 5, 7), null); // wall behind red
  assert.deepEqual(cells(R.legalMoves(g, 0)), ['4,8', '4,9', '6,8', '6,9']);
});

test('forfeit hands the win to the last remaining side; auto-move is legal', () => {
  const g = R.newGame('ffa', 20, 3);
  R.forfeit(g, 1);
  assert.equal(g.winner, null);
  assert.equal(R.act(g, 0, R.autoMove(g, 0)), null);
  assert.equal(g.turn, 2); // dead seat skipped
  R.forfeit(g, 2);
  assert.equal(g.winner, 0);
});
