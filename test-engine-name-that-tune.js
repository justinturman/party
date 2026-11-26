import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game, config, source } from '../party-game-name-that-tune/server.js';

const { Client } = boardgameClient;
const { Local } = boardgameMultiplayer;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failures++;
};

config.getReadyMs = 300; // short timings for the test
config.clipMs = 700;
config.graceMs = 150;
let available = true;
let n = 0;
source.take = () =>
  available
    ? {
        song: { id: n++, title: 'Right Song', artist: 'Right Artist', decade: 1980, kind: 'deezer', audio: 'https://example.com/clip.mp3', cover: null },
        wrong: [{ title: 'W1', artist: 'A1' }, { title: 'W2', artist: 'A2' }, { title: 'W3', artist: 'A3' }],
      }
    : null;
source.status = () => ({ ready: 0, songs: 100, error: null });

const multiplayer = Local();
const make = (id) => {
  const c = Client({ game, matchID: 'ntt', playerID: id, numPlayers: 16, multiplayer, debug: false });
  c.start();
  return c;
};
const a = make('0');
const b = make('1');
const c = make('2');
const tv = make(undefined); // a spectator, like the TV
const G = (cl) => cl.getState().G;

// Sends a move the way a phone does: resend until the server's count shows it was accepted
async function op(cl, name, ...args) {
  for (let i = 0; i < 6; i++) {
    const before = G(cl).mySeq;
    cl.moves[name](before + 1, ...args);
    await wait(120);
    if (G(cl).mySeq > before) return true;
  }
  return false;
}
await wait(300);

check('the game waits to be started', G(tv).phase === 'idle');
await op(b, 'next', 0);
check('a player other than player 0 can start the first song', G(tv).phase === 'round' && G(tv).round === 1 && G(tv).options.length === 4);
check('the TV gets the clip address but a phone does not', G(tv).audio === 'https://example.com/clip.mp3' && G(a).audio === null);
check('nobody gets the right answer yet', !JSON.stringify(G(tv)).includes('correct') && !JSON.stringify(G(a)).includes('correct'));

await op(a, 'lock', 1, 0);
check('an answer before the clip starts is ignored', Object.keys(G(tv).locked).length === 0);

await wait(config.getReadyMs + 100);
await Promise.all([op(a, 'lock', 1, 0), op(b, 'lock', 1, 1), op(c, 'lock', 1, 2)]);
check('three simultaneous answers all get through', ['0', '1', '2'].every((id) => G(tv).locked[id]));
check('the TV sees who locked in but not what', !JSON.stringify(G(tv)).includes('"choice"') && G(tv).myChoice === null);
check('every player sees only their own answer', G(a).myChoice === 0 && G(b).myChoice === 1 && G(c).myChoice === 2);

await wait(config.clipMs + config.graceMs + 100);
await op(c, 'tick');
const R = G(tv).result;
check('a tick from another player ends the round', G(tv).phase === 'reveal' && !!R && R.picks['0'] === 0 && R.picks['2'] === 2);
const winners = Object.keys(R.picks).filter((id) => R.picks[id] === R.correct);
check('only the players who chose right score',
  ['0', '1', '2'].every((id) => (winners.includes(id) ? R.gains[id] >= 100 && R.gains[id] <= 200 : R.gains[id] === 0)));
check('the totals match the points gained', ['0', '1', '2'].every((id) => (G(tv).scores[id] || 0) === R.gains[id]));

await op(a, 'next', 1);
check('any player can start the next song', G(tv).phase === 'round' && G(tv).round === 2);
await op(b, 'next', 1);
check('a second press for the same song does nothing', G(tv).round === 2);

await wait(config.getReadyMs + config.clipMs + config.graceMs + 150);
await op(a, 'tick');
check('a round nobody answered still ends', G(tv).phase === 'reveal' && Object.keys(G(tv).result.picks).length === 0);

available = false;
await op(b, 'next', 2);
check('with no song ready the game waits', G(tv).phase === 'loading');
available = true;
await op(c, 'load');
check('as soon as a song is ready the round starts', G(tv).phase === 'round' && G(tv).round === 3);

await wait(config.getReadyMs + 100);
const late = make('9');
await wait(200);
await op(late, 'lock', 3, 0);
check('a player who joins mid-round can answer at once', G(tv).locked['9'] === true);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);