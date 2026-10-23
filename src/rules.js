// WALL ARENA rules engine: pure, dependency-free, used by the server and the tests.
// Cell (x,y): x grows right, y grows down, 0..n-1. A wall is 2 cells long, anchored at (x,y) in 0..n-2 and centred
// on the corner shared by cells (x,y),(x+1,y),(x,y+1),(x+1,y+1):
//   'h' blocks vertical moves between rows y|y+1 in columns x,x+1;  'v' blocks horizontal moves between columns x|x+1 in rows y,y+1.
export const SIZES = [10, 20, 30, 40, 50];
export const MODES = { '1v1': { min: 2, cap: 2 }, '1v2': { min: 3, cap: 3 }, '1v3': { min: 4, cap: 4 }, ffa: { min: 3, cap: 4 } };
export const COLORS = ['blue', 'red', 'green', 'yellow'];
export const wallsFor = n => Math.floor((n * n) / 10);
export const teamOf = (mode, s) => (mode === 'ffa' ? s : s ? 1 : 0); // 1vN: seat 0 (blue) is alone, everyone else is one team

const ROT = [0, 2, 1, 3]; // seat -> rotation: blue starts bottom (goal top), red top, green left, yellow right
const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const rot = (k, n, x, y) => [[x, y], [n - 1 - y, x], [n - 1 - x, n - 1 - y], [y, n - 1 - x]][k];
const key = (x, y) => (x << 6) | y; // n <= 50 < 64, negatives never collide with real keys
const isH = (g, x, y) => g.hw.has(key(x, y));
const isV = (g, x, y) => g.vw.has(key(x, y));

export function newGame(mode, n, count) {
  const c = n >> 1;
  const players = Array.from({ length: count }, (_, s) => {
    const k = ROT[s], [x, y] = rot(k, n, c, n - 1);
    return { seat: s, k, x, y, walls: wallsFor(n), team: teamOf(mode, s), alive: true };
  });
  return { n, mode, players, hw: new Set(), vw: new Set(), turn: 0, winner: null, version: 0 };
}

function blocked(g, x, y, dx, dy) {
  if (dy === 1) return isH(g, x, y) || isH(g, x - 1, y);
  if (dy === -1) return isH(g, x, y - 1) || isH(g, x - 1, y - 1);
  if (dx === 1) return isV(g, x, y) || isV(g, x, y - 1);
  return isV(g, x - 1, y) || isV(g, x - 1, y - 1);
}
const open = (g, x, y, dx, dy) => {
  const a = x + dx, b = y + dy;
  return a >= 0 && b >= 0 && a < g.n && b < g.n && !blocked(g, x, y, dx, dy);
};
const at = (g, x, y) => g.players.some(p => p.alive && p.x === x && p.y === y);

// Step to a free neighbour; an occupied neighbour is jumped straight if the landing cell is free and unwalled,
// otherwise the two cells beside that neighbour become available.
export function legalMoves(g, seat) {
  const p = g.players[seat], out = [];
  for (const [dx, dy] of D) {
    if (!open(g, p.x, p.y, dx, dy)) continue;
    const nx = p.x + dx, ny = p.y + dy;
    if (!at(g, nx, ny)) { out.push([nx, ny]); continue; }
    if (open(g, nx, ny, dx, dy) && !at(g, nx + dx, ny + dy)) { out.push([nx + dx, ny + dy]); continue; }
    for (const [ex, ey] of dx ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]])
      if (open(g, nx, ny, ex, ey) && !at(g, nx + ex, ny + ey)) out.push([nx + ex, ny + ey]);
  }
  return out;
}

// Steps-to-goal for every cell (-1 = unreachable) for rotation k; tokens are ignored, walls are not.
export function field(g, k) {
  const n = g.n, f = new Int16Array(n * n).fill(-1), q = [];
  for (let i = 0; i < n; i++) { const [x, y] = [[i, 0], [n - 1, i], [i, n - 1], [0, i]][k]; f[y * n + x] = 0; q.push(y * n + x); }
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = c % n, y = (c / n) | 0;
    for (const [dx, dy] of D) if (open(g, x, y, dx, dy)) { const m = c + dx + dy * n; if (f[m] < 0) { f[m] = f[c] + 1; q.push(m); } }
  }
  return f;
}

export const atGoal = (g, p) => [p.y === 0, p.x === g.n - 1, p.y === g.n - 1, p.x === 0][p.k];

export function wallError(g, seat, o, x, y) {
  if (o !== 'h' && o !== 'v') return 'bad wall';
  if (g.players[seat].walls < 1) return 'no walls left';
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > g.n - 2 || y > g.n - 2) return 'out of bounds';
  const A = o === 'h' ? g.hw : g.vw, B = o === 'h' ? g.vw : g.hw, k = key(x, y);
  if (A.has(k) || B.has(k)) return 'wall conflict'; // same spot, or crossing at the same corner
  if ((o === 'h' ? [key(x - 1, y), key(x + 1, y)] : [key(x, y - 1), key(x, y + 1)]).some(j => A.has(j))) return 'wall overlap';
  A.add(k);
  const ok = g.players.every(p => !p.alive || field(g, p.k)[p.y * g.n + p.x] >= 0);
  A.delete(k);
  return ok ? null : 'blocks all routes';
}

const next = g => { do g.turn = (g.turn + 1) % g.players.length; while (!g.players[g.turn].alive); };

// Applies one action {t:'move',x,y} | {t:'wall',o,x,y} | {t:'pass'}. Returns an error string or null.
export function act(g, seat, a) {
  if (g.winner !== null) return 'game over';
  if (seat !== g.turn) return 'not your turn';
  const p = g.players[seat];
  if (a.t === 'move') {
    if (!legalMoves(g, seat).some(([x, y]) => x === a.x && y === a.y)) return 'illegal move';
    p.x = a.x; p.y = a.y;
    if (atGoal(g, p)) g.winner = p.team;
  } else if (a.t === 'wall') {
    const e = wallError(g, seat, a.o, a.x, a.y);
    if (e) return e;
    (a.o === 'h' ? g.hw : g.vw).add(key(a.x, a.y)); p.walls--;
  } else if (a.t === 'pass') {
    if (legalMoves(g, seat).length) return 'illegal pass'; // only when completely boxed in by tokens
  } else return 'bad action';
  g.version++;
  if (g.winner === null) next(g);
  return null;
}

export function forfeit(g, seat) {
  g.players[seat].alive = false; g.version++;
  const teams = new Set(g.players.filter(p => p.alive).map(p => p.team));
  if (teams.size <= 1) g.winner = teams.size ? [...teams][0] : -1;
  else if (g.turn === seat) next(g);
}

// Used for expired/absent turns: the legal step that is closest to the goal.
export function autoMove(g, seat) {
  const p = g.players[seat], f = field(g, p.k), m = legalMoves(g, seat);
  if (!m.length) return { t: 'pass' };
  m.sort((a, b) => f[a[1] * g.n + a[0]] - f[b[1] * g.n + b[0]]);
  return { t: 'move', x: m[0][0], y: m[0][1] };
}
