import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game, config } from './games/psychic-test/server.js';

const { Client } = boardgameClient;
const { Local } = boardgameMultiplayer;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failures++;
};

config.guessMs = 700; // short timings for the test
config.revealMs = 400;
config.graceMs = 150;

const multiplayer = Local();
const make = (id) => {
  const c = Client({ game, matchID: 'pt', playerID: id, numPlayers: 16, multiplayer, debug: false });
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

check('the game waits for the first player', G(tv).phase === 'idle');
await op(b, 'hello');
check('a player other than player 0 can join and start the game', G(tv).phase === 'guessing' && G(tv).round === 1);
await op(a, 'hello');
await op(c, 'hello');
check('three players are in', Object.keys(G(tv).members).length === 3);

const round = G(tv).round;
await Promise.all([op(a, 'lock', round, 0), op(b, 'lock', round, 1), op(c, 'lock', round, 2)]);
check('three simultaneous guesses all get through, with resending',
  ['0', '1', '2'].every((id) => G(tv).members[id].locked));
check('the TV sees who locked in but never what', !JSON.stringify(G(tv)).includes('picks') && G(tv).myPick === null);
check('every player sees only their own guess', G(a).myPick === 0 && G(b).myPick === 1 && G(c).myPick === 2);
check('the clock jumps to a short grace period', G(tv).timer.left <= config.graceMs + 100);

await wait(config.graceMs + 150);
await op(b, 'tick');
check('a tick from another player reveals the card',
  G(tv).phase === 'reveal' && G(tv).last.round === 1 && G(tv).last.picks['1'] === 1 && G(tv).recent.length === 1);

await wait(config.revealMs + 80);
await op(c, 'tick');
check('after the reveal the next round starts', G(tv).phase === 'guessing' && G(tv).round === 2);

await wait(config.guessMs + 100);
await op(a, 'tick');
check('with no guesses, play stops to ask if anyone is there', G(tv).phase === 'checkin' && G(tv).recent.length === 1);

await op(c, 'imHere');
check('anyone saying they are here starts a fresh round', G(tv).phase === 'guessing' && G(tv).round === 3);

await op(b, 'pause');
check('a player can pause the game', G(tv).phase === 'paused' && G(tv).paused.by === '1');
await op(a, 'resume');
check('another player can resume it', G(tv).phase === 'guessing');

await op(c, 'goAway');
check('a player who leaves is marked away', G(tv).members['2'].away === true);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);