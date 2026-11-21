import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import serve from 'koa-static';
import boardgameServer from 'boardgame.io/dist/cjs/server.js';
import { catalog } from './games/index.js';

const { Server, Origins } = boardgameServer;
const here = path.dirname(fileURLToPath(import.meta.url));

// Room codes: 4 letters, skipping I and O (they look like 1 and 0)
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const roomCode = () =>
  Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');

// Pages opened from home-network addresses (phones on your Wi-Fi), any port
const LAN =
  /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

// The public address of the deployed site (Render provides the first one itself)
const publicOrigins = [process.env.RENDER_EXTERNAL_URL, process.env.PUBLIC_ORIGIN].filter(Boolean);

const server = Server({
  games: catalog.map((g) => g.game),
  origins: [Origins.LOCALHOST, LAN, ...publicOrigins],
  uuid: roomCode,
  generateCredentials: () => crypto.randomUUID(),
});

const PORT = Number(process.env.PORT) || 8000;
server.run(PORT, () => {
  // Serve the website built by "npm run build"
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