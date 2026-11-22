import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game } from './games/most-likely-to/server.js';

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
  const c = Client({ game, matchID: 'mlt', playerID: id, numPlayers: 3, multiplayer, debug: false });
  c.start();
  return c;
});
const G = (i) => clients[i].getState().G;
await wait(200);

clients[2].moves.vote('0');
await wait(100);
check('players other than player 0 can vote', G(0).votedCount === 1);

clients[0].moves.vote('0'); // voting for yourself
await wait(100);
check('voting for yourself is refused', G(0).votedCount === 1);

clients[0].moves.vote('1');
await wait(100);
clients[1].moves.vote('0');
await wait(100);
check('the reveal happens by itself after the last vote',
  G(0).phase === 'revealed' && G(0).result.winners.length === 1 && G(0).result.winners[0] === '0');

clients[1].moves.next(5);
await wait(100);
check('a next with the wrong round is ignored', G(0).phase === 'revealed');

clients[2].moves.next(0);
await wait(100);
check('any player can move on', G(0).phase === 'voting' && G(0).round === 1);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);