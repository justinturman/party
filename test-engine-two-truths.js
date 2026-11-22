import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game } from '../party-game-two-truths-and-a-lie/server.js';

const { Client } = boardgameClient;
const { Local } = boardgameMultiplayer;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failures++;
};

const multiplayer = Local();
const clients = ['0', '1', '2'].map((id) => {
  const c = Client({ game, matchID: 'tt', playerID: id, numPlayers: 3, multiplayer, debug: false });
  c.start();
  return c;
});
const view = (i) => clients[i].getState().G;
await wait(200);

// Start with player 2, who is NOT the "current player"
for (const i of [2, 1, 0]) {
  clients[i].moves.submit(['truth one', 'truth two', 'a lie'], 2);
  await wait(100);
}
check('players other than player 0 can submit', view(0).phase === 'reveal');

const subject = Number(view(0).subject);
const voters = [0, 1, 2].filter((i) => i !== subject);

clients[subject].moves.vote(0);
await wait(100);
check('the subject cannot vote', view(0).votedCount === 0);

for (const i of voters) {
  clients[i].moves.vote(1);
  await wait(100);
}
check('the reveal happens by itself after the last vote', view(0).revealed === true);

clients[subject].moves.next();
await wait(100);
check('the subject can move on', view(0).currentIndex === 1 && view(0).revealed === false);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);