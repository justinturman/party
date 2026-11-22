import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game, config } from '../party-game-password-taboo/server.js';

const { Client } = boardgameClient;
const { Local } = boardgameMultiplayer;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failures++;
};

config.turnMs = 600; // a short turn for the test

const multiplayer = Local();
const clients = ['0', '1', '2', '3'].map((id) => {
  const c = Client({ game, matchID: 'pw', playerID: id, numPlayers: 4, multiplayer, debug: false });
  c.start();
  return c;
});
const G = (i) => clients[i].getState().G;
await wait(200);

clients[1].moves.startTurn();
await wait(100);
check('only the giver can start the turn', G(0).phase === 'ready');

clients[0].moves.startTurn();
await wait(100);
check('the giver starts the turn', G(0).phase === 'playing');
check('only the giver and the referee see the card',
  !!G(0).card && !!G(1).card && G(2).card === null && G(3).card === null);

clients[1].moves.taboo();
await wait(100);
check('player 1 (not player 0) can press the buzzer', G(0).scores[0] === -1);

clients[2].moves.got();
await wait(100);
check('a teammate cannot score for the giver', G(0).scores[0] === -1);

clients[0].moves.got();
await wait(100);
check('the giver can score', G(0).scores[0] === 0);

clients[3].moves.endTurn();
await wait(100);
check('the turn cannot be ended early', G(0).phase === 'playing');

await wait(700);
clients[3].moves.endTurn();
await wait(100);
check('after time is up another player ends the turn',
  G(0).phase === 'turnEnd' && G(0).recap.results.length === 2);

clients[2].moves.nextTurn(0);
await wait(100);
check('any player can move on, and the other team is up',
  G(0).phase === 'ready' && G(0).info.giver === '1');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);