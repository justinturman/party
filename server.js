import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import serve from 'koa-static';
import boardgameServer from 'boardgame.io/dist/cjs/server.js';

const { Server, Origins } = boardgameServer;
const here = path.dirname(fileURLToPath(import.meta.url));
const gamesDir = path.join(here, 'games');
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
}));

// Each game's public/ folder is served at /g/<id>/
const gameFiles = {};
for (const g of loaded) gameFiles[g.manifest.id] = serve(path.join(g.dir, 'public'));

// Room codes: 4 letters, skipping I and O (they look like 1 and 0)
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const roomCode = () =>
  Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');

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
    for (const id of old) await server.db.wipe(id);
    if (old.length) console.log(`Cleaned up ${old.length} old rooms`);
  } catch (e) {
    console.log('Cleanup skipped:', e.message);
  }
}, 10 * 60 * 1000);