# WALL ARENA

Online multiplayer wall-placement strategy on a 10×10 – 50×50 grid. 1v1, 1v2, 1v3 or free-for-all, up to 4 real players.
Authoritative Node + Express + Socket.IO server (it validates every move/wall); plain-JS canvas client, no build step.

## Run (Node 18+; Termux: `pkg install nodejs unzip`)
    npm install
    npm start        # http://localhost:3000   (PORT=… to change)
    npm test         # rules + room/matchmaking tests (node:test, no extra deps)
Same Wi-Fi: open `http://<your-device-ip>:3000` on the other phones/PCs. Players are guests; the browser keeps a private token so a refresh/reconnect returns to the match.

## Play over the internet (deploy)
Any host with a persistent Node process and WebSockets works (Render, Railway, Fly.io, a VPS).
Build: `npm install` · Start: `npm start` · Health check: `/health` · Env: `PORT` (host sets it), optional `CORS_ORIGIN` (see `.env.example`; `node --env-file=.env server.js` on Node 20.6+).
The server also serves the client, so one web service is the whole game. Run **one instance** (rooms live in memory). Nothing has been deployed by this project; a public link exists only after you deploy it.

## Rules
- Coordinates: cell (x,y), y grows downward. A wall is 2 cells long. `h` at (x,y) blocks vertical moves between rows y|y+1 in columns x,x+1; `v` blocks horizontal moves between columns x|x+1 in rows y,y+1.
- Walls per player = ⌊size²÷10⌋ (10, 40, 90, 160, 250). Walls can't overlap/cross or leave any player without a route (checked by BFS on the server).
- A turn = one step or one wall. Adjacent tokens can be jumped; if the landing is blocked, step diagonally around them.
- Blue starts bottom (goal top), red top, green left, yellow right. Turn order blue → red → green → yellow.
- 1v1 / free-for-all: first to their goal edge wins. 1v2 / 1v3: blue plays alone; the other team wins when **any** teammate reaches their goal. Last side standing also wins (forfeits/leavers).
- Turn timer 15–90 s (room setting). A missed turn is auto-played (best step toward goal); 3 misses in a row forfeit. Offline players are auto-played; reconnecting resumes.
- Public Quick Match rooms are keyed by mode + size and start when full (a 3-player free-for-all waits 5 s for a 4th).

## Layout
`src/rules.js` rules engine · `src/rooms.js` rooms, matchmaking, timers, reconnect · `server.js` Express + Socket.IO (rate limit, input checks, `/health`) · `public/index.html` client · `test/` tests.

## Not included yet
Accounts/PostgreSQL, profiles, match history, leaderboard (guest play only, state is in memory and resets on restart) · React/TypeScript/Vite (plain JS instead) · automated browser/mobile-layout tests · pinch-zoom is the browser's own; big boards scroll.
