import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game, SCENES } from './games/find-it/server.js';

const { Client } = boardgameClient;
const { Local } = boardgameMultiplayer;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failures++;
};
const note = (label, ok) => console.log(ok ? 'PASS' : 'NOTE', label); // informational, not counted

const multiplayer = Local();
const make = (id) => {
  const c = Client({ game, matchID: 'fi', playerID: id, numPlayers: 16, multiplayer, debug: false });
  c.start();
  return c;
};
const a = make('0');
const b = make('1');
const c = make('2');
const tv = make(undefined); // a spectator, like the TV
const G = (cl) => cl.getState().G;
const tap = (cl, x, y) => cl.moves.tap(G(cl).mySeq + 1, x, y);
await wait(300);

const scene = () => SCENES.find((s) => s.id === G(a).scene.id);
const it = (i) => scene().items[i];

// A point that is clear of every item, for a deliberate miss
function emptyPoint(s) {
  for (let x = 0.03; x < 1; x += 0.04) {
    for (let y = 0.03; y < 1; y += 0.04) {
      if (s.items.every((i) => Math.hypot((x - i.x) * s.width, (y - i.y) * s.height) > i.r * s.width * 1.5)) return { x, y };
    }
  }
  return { x: 0.001, y: 0.001 };
}

check('the TV receives no item positions', !JSON.stringify(G(tv)).includes('"x"'));

tap(b, it(0).x, it(0).y);
await wait(100);
check('players other than player 0 can find items', G(tv).found.length === 1 && G(tv).found[0].by === '1');
check('everyone sees where it was', G(c).found[0].x === it(0).x);

tap(a, it(1).x, it(1).y);
await wait(100);
check('the first player can find items too', G(tv).found.length === 2);

const miss = emptyPoint(scene());
tap(c, miss.x, miss.y);
await wait(100);
check('a wrong tap starts a pause for that player only', G(c).cool > 0 && G(a).cool === 0);

tap(c, it(2).x, it(2).y);
await wait(100);
check('a tap during the pause is ignored', G(tv).found.length === 2);

// Two players tap different items at the same moment
const seqA = G(a).mySeq + 1;
const seqB = G(b).mySeq + 1;
a.moves.tap(seqA, it(2).x, it(2).y);
b.moves.tap(seqB, it(3).x, it(3).y);
await wait(200);
note('two simultaneous taps were both counted (the phone resends a refused tap)', G(tv).found.length === 4);

// Finish the picture
for (let i = 0; i < scene().items.length; i++) {
  if (G(tv).found.some((f) => f.i === i)) continue;
  tap(b, it(i).x, it(i).y);
  await wait(60);
}
check('the picture ends when every item is found', G(tv).phase === 'done' && G(tv).winners.length >= 1);

const round = G(c).round;
c.moves.nextScene(round);
await wait(100);
check('any player can start the next game', G(tv).phase === 'playing' && G(tv).round === round + 1 && G(tv).found.length === 0);

// A newcomer arrives mid-game
const late = make('9');
await wait(200);
tap(late, it(0).x, it(0).y);
await wait(100);
check('a player who joins mid-game can score at once', G(tv).found.length === 1 && G(tv).found[0].by === '9');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);