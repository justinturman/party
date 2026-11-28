import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import serve from 'koa-static';
import boardgameServer from 'boardgame.io/dist/cjs/server.js';

const { Server, Origins } = boardgameServer;
const here = path.dirname(fileURLToPath(import.meta.url));
const gamesDir = path.join(here, 'games');
const indexFile = path.join(here, 'dist', 'index.html');
fs.mkdirSync(gamesDir, { recursive: true });

// ---- Discover games: every folder with a game.json and a server.js ----
const loaded = [];
for (const dirent of fs.readdirSync(gamesDir, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const dir = path.join(gamesDir, dirent.name);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
    const mod = await import(pathToFileURL(path.join(dir, 'server.js')).href);
    const game = mod.game;
    if (!game) throw new Error('server.js must export "game"');
    if (manifest.id !== dirent.name || game.name !== manifest.id) {
      throw new Error('the id in game.json, the folder name and the game name must match');
    }
    if (typeof mod.init === 'function') mod.init();
    loaded.push({ manifest, game, dir });
    console.log(`Loaded game: ${manifest.name}`);
  } catch (e) {
    console.log(`Skipping games/${dirent.name}: ${e.message}`);
  }
}

// What the browser is told about each game (never any rules or secrets)
const publicCatalog = loaded.map(({ manifest, game }) => ({
  id: manifest.id,
  name: manifest.name,
  category: manifest.category || 'Other',
  description: manifest.description || '',
  summary: manifest.summary || '',
  minPlayers: game.minPlayers,
  maxPlayers: game.maxPlayers,
  moves: Object.keys(game.moves || {}),
  thumbnail: /^[\w.-]+$/.test(manifest.thumbnail || '')
    ? `/g/${manifest.id}/${manifest.thumbnail}`
    : null,
  color: /^#[0-9a-fA-F]{3,8}$/.test(manifest.color || '') ? manifest.color : '#33334d',
  openJoin: manifest.openJoin === true,
  // How many players must be present for a game to run. Optional in game.json; when a game
  // does not say, the minimum is 1 (so an empty room always goes back to the join screen).
  minJoined: Math.max(1, Math.floor(Number(manifest.minJoined)) || 1),
  help: typeof manifest.help === 'string' ? manifest.help.slice(0, 4000) : '',
}));

// Each game's public/ folder is served at /g/<id>/
const gameFiles = {};
for (const g of loaded) gameFiles[g.manifest.id] = serve(path.join(g.dir, 'public'));

// Room codes: 4 letters, skipping I and O (they look like 1 and 0)
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const issued = new Set(); // codes in use, so two rooms can never share one
const roomCode = () => {
  let code;
  do {
    code = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
  } while (issued.has(code));
  issued.add(code);
  return code;
};

// Host keys: the TV that creates a room claims it with a secret key, and only that key can
// close the room. Only a hash is kept. (In memory, like the rooms themselves.)
const hostKeys = new Map(); // room code -> sha256 hex of the key
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const KEY_FORMAT = /^[0-9a-f]{32}$/;

// Reads a small JSON body. Always gives back an object (a body of null, a number or junk
// becomes {}), so callers can read fields without checking.
async function readBody(ctx) {
  let body = {};
  try {
    let raw = '';
    for await (const chunk of ctx.req) {
      raw += chunk;
      if (raw.length > 2000) break;
    }
    body = JSON.parse(raw);
  } catch (e) {
    body = {};
  }
  if (!body || typeof body !== 'object') body = {};
  return body;
}

// Pages opened from home-network addresses (phones on Wi-Fi), any port
const LAN =
  /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

// The public address of the deployed site (Render provides the first one itself)
const publicOrigins = [process.env.RENDER_EXTERNAL_URL, process.env.PUBLIC_ORIGIN].filter(Boolean);

const server = Server({
  games: loaded.map((g) => g.game),
  origins: [Origins.LOCALHOST, LAN, ...publicOrigins],
  uuid: roomCode,
  generateCredentials: () => crypto.randomUUID(),
});

const PORT = Number(process.env.PORT) || 8000;
server.run(PORT, () => {
  server.app.use(async (ctx, next) => {
    // The list of games
    if (ctx.path === '/catalog.json') {
      ctx.set('Access-Control-Allow-Origin', '*');
      ctx.body = publicCatalog;
      return;
    }
        // A player gives up their seat: POST /vacate/ABCD  {"playerID":"0","credentials":"..."}
    // The seat becomes free, but the room stays (boardgame.io's own "leave" deletes the room
    // when its last player leaves, which would strand the TV).
    const vacate = ctx.path.match(/^\/vacate\/([A-Za-z]{4})$/);
    if (vacate && ctx.method === 'POST') {
      ctx.set('Access-Control-Allow-Origin', '*');
      const code = vacate[1].toUpperCase();
      const body = await readBody(ctx);
      let metadata = null;
      try {
        ({ metadata } = await server.db.fetch(code, { metadata: true }));
      } catch (e) {
        metadata = null;
      }
      const seat = metadata && metadata.players && metadata.players[body.playerID];
      if (!seat || typeof body.credentials !== 'string' || seat.credentials !== body.credentials) {
        ctx.status = 403;
        ctx.body = { error: 'Not your seat' };
        return;
      }
      delete seat.name;
      delete seat.credentials;
      await server.db.setMetadata(code, metadata);
      ctx.body = {};
      return;
    }
    // The TV has left the game: POST /close/ABCD deletes the room. Phones notice it is gone
    // and go back to the home screen.
    const closing = ctx.path.match(/^\/close\/([A-Za-z]{4})$/);
    if (closing && ctx.method === 'POST') {
      ctx.set('Access-Control-Allow-Origin', '*');
      const code = closing[1].toUpperCase();
      const body = await readBody(ctx);
      const expected = hostKeys.get(code);
      // Only the TV that claimed the room can close it
      if (!expected || typeof body.hostKey !== 'string' || !sameSecret(sha(body.hostKey).toString('hex'), expected)) {
        ctx.status = 403;
        ctx.body = { error: 'Not the host' };
        return;
      }
      try {
        await server.db.wipe(code);
      } catch (e) {
        /* already gone */
      }
      issued.delete(code);
      hostKeys.delete(code);
      ctx.body = {};
      return;
    }
    // The TV claims a room it has just created: POST /host/ABCD  {"hostKey":"<32 hex chars>"}
    // Works once per room; after that the room has an owner.
    const claiming = ctx.path.match(/^\/host\/([A-Za-z]{4})$/);
    if (claiming && ctx.method === 'POST') {
      ctx.set('Access-Control-Allow-Origin', '*');
      const code = claiming[1].toUpperCase();
      const body = await readBody(ctx);
      let metadata = null;
      try {
        ({ metadata } = await server.db.fetch(code, { metadata: true }));
      } catch (e) {
        metadata = null;
      }
      if (!metadata) {
        ctx.status = 404;
        ctx.body = { error: 'No such room' };
        return;
      }
      if (typeof body.hostKey !== 'string' || !KEY_FORMAT.test(body.hostKey)) {
        ctx.status = 400;
        ctx.body = { error: 'Bad key' };
        return;
      }
      if (hostKeys.has(code)) {
        ctx.status = 409;
        ctx.body = { error: 'Already claimed' };
        return;
      }
      hostKeys.set(code, sha(body.hostKey).toString('hex'));
      ctx.body = {};
      return;
    }
    // Does this seat still belong to the caller? POST /seat/ABCD {"playerID":"0","credentials":"..."}
    const seatCheck = ctx.path.match(/^\/seat\/([A-Za-z]{4})$/);
    if (seatCheck && ctx.method === 'POST') {
      ctx.set('Access-Control-Allow-Origin', '*');
      const code = seatCheck[1].toUpperCase();
      const body = await readBody(ctx);
      let metadata = null;
      try {
        ({ metadata } = await server.db.fetch(code, { metadata: true }));
      } catch (e) {
        metadata = null;
      }
      const seat = metadata && metadata.players && metadata.players[body.playerID];
      if (!seat || typeof body.credentials !== 'string' || seat.credentials !== body.credentials) {
        ctx.status = 403;
        ctx.body = { error: 'Not your seat' };
        return;
      }
      ctx.body = {};
      return;
    }
    // Which game does a room code belong to?   GET /room/ABCD  ->  { "game": "find-it" }
    const room = ctx.path.match(/^\/room\/([A-Za-z]{4})$/);
    if (room) {
      ctx.set('Access-Control-Allow-Origin', '*');
      let metadata = null;
      try {
        ({ metadata } = await server.db.fetch(room[1].toUpperCase(), { metadata: true }));
      } catch (e) {
        metadata = null;
      }
      if (!metadata || !metadata.gameName) {
        ctx.status = 404;
        ctx.body = { error: 'No such room' };
        return;
      }
      ctx.body = { game: metadata.gameName };
      return;
    }
    // Room links look like /ABCD. Hand back the app's start page; it works out the rest.
    if (/^\/[A-Za-z]{4}\/?$/.test(ctx.path) && fs.existsSync(indexFile)) {
      ctx.type = 'html';
      ctx.body = fs.createReadStream(indexFile);
      return;
    }
    // A game's own screens
    const m = ctx.path.match(/^\/g\/([a-z0-9-]+)(\/.*)?$/);
    if (m && gameFiles[m[1]]) {
      const original = ctx.path;
      ctx.path = !m[2] || m[2] === '/' ? '/index.html' : m[2];
      return gameFiles[m[1]](ctx, async () => {
        ctx.path = original;
        await next();
      });
    }
    await next();
  });
  // The platform's own website, built by "npm run build"
  server.app.use(serve(path.join(here, 'dist')));
  console.log(`Server running on port ${PORT}`);
});

// Forget rooms that haven't been used for 6 hours, so memory doesn't fill up
const MAX_AGE = 6 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const old = await server.db.listMatches({
      where: { updatedBefore: Date.now() - MAX_AGE },
    });
    for (const id of old) {
      await server.db.wipe(id);
      issued.delete(id);
      hostKeys.delete(id);
    }
    if (old.length) console.log(`Cleaned up ${old.length} old rooms`);
  } catch (e) {
    console.log('Cleanup skipped:', e.message);
  }
}, 10 * 60 * 1000);

// Free the seats of phones that closed their tab (or lost their connection for good).
// boardgame.io marks a seat isConnected:false when its socket drops; a refresh reconnects
// within seconds, so a seat is only given up after it has been offline for SEAT_GRACE_MS.
// A seat that has never connected (no isConnected value yet) counts as offline too, so a
// phone that joined and then died before its socket opened does not hold the seat forever.
// Only open-join games do this: fixed-seat games need every seat to stay reserved.
const SEAT_GRACE_MS = Number(process.env.SEAT_GRACE_MS) || 60 * 1000;
const openJoinGames = new Set(loaded.filter((g) => g.manifest.openJoin === true).map((g) => g.manifest.id));
const offlineSince = new Map(); // "CODE:seat" -> when it was first seen offline
setInterval(async () => {
  try {
    const now = Date.now();
    const stillOffline = new Set();
    for (const id of await server.db.listMatches({})) {
      let { metadata } = await server.db.fetch(id, { metadata: true });
      if (!metadata || !openJoinGames.has(metadata.gameName)) continue;
      for (const [pid, seat] of Object.entries(metadata.players || {})) {
        // Offline means "not known to be connected": a seat that joined but never opened a
        // socket has no isConnected value at all, and must expire too.
        if (!seat.name || seat.isConnected === true) continue;
        const key = `${id}:${pid}`;
        stillOffline.add(key);
        if (!offlineSince.has(key)) offlineSince.set(key, now);
        if (now - offlineSince.get(key) < SEAT_GRACE_MS) continue;
        // Look again right before writing, in case the phone has just come back
        ({ metadata } = await server.db.fetch(id, { metadata: true }));
        const fresh = metadata && metadata.players && metadata.players[pid];
        if (!fresh || !fresh.name || fresh.isConnected === true) continue;
        delete fresh.name;
        delete fresh.credentials;
        await server.db.setMetadata(id, metadata);
        offlineSince.delete(key);
        console.log(`Freed seat ${pid} in room ${id} (offline too long)`);
      }
    }
    for (const key of offlineSince.keys()) if (!stillOffline.has(key)) offlineSince.delete(key);
  } catch (e) {
    console.log('Seat check skipped:', e.message);
  }
}, 10 * 1000);