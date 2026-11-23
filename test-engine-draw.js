import boardgameClient from 'boardgame.io/dist/cjs/client.js';
import boardgameMultiplayer from 'boardgame.io/dist/cjs/multiplayer.js';
import { game, config } from './games/draw/server.js';

const { Client } = boardgameClient;
const { Local } = boardgameMultiplayer;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failures++;
};

config.drawMs = 800; // a short turn for the test

const multiplayer = Local();
const clients = ['0', '1', '2'].map((id) => {
  const c = Client({ game, matchID: 'dr', playerID: id, numPlayers: 3, multiplayer, debug: false });
  c.start();
  return c;
});
const G = (i) => clients[i].getState().G;
await wait(200);

check('only the drawer sees the word options', G(0).options.length === 3 && G(1).options === null);
clients[1].moves.choose(0);
await wait(100);
check('only the drawer can choose', G(0).phase === 'choosing');
clients[0].moves.choose(0);
await wait(100);
const word = G(0).word;
check('the drawer starts drawing and sees the word', G(0).phase === 'drawing' && typeof word === 'string');
check('other players get only a hint', G(1).word === null && G(2).word === null && typeof G(1).hint === 'string');

clients[0].moves.draw(1, { c: 2, w: 1, p: [10, 10, 80, 80], n: true });
await wait(100);
check('everyone sees the stroke straight away', G(1).strokes.length === 1 && G(2).strokes.length === 1);
check('the drawer gets an acknowledgement number', G(0).mySeq === 1);

clients[1].moves.guess(1, 'definitely wrong');
await wait(100);
check('players other than player 0 can guess', G(2).log.length === 1 && G(2).log[0].type === 'guess');

clients[1].moves.guess(2, word);
await wait(100);
check('a correct guess scores for the guesser and the drawer',
  G(1).guessed['1'] !== undefined && G(0).scores['0'] > 0);
check('the word stays secret from the other guesser', G(2).word === null);

clients[2].moves.guess(1, word.toUpperCase());
await wait(100);
check('the turn ends once everyone has guessed', G(0).phase === 'turnEnd' && G(2).word === word);

clients[2].moves.nextTurn(0);
await wait(100);
check('the next player draws next', G(0).phase === 'choosing' && G(0).drawer === '1');

clients[1].moves.choose(1);
await wait(100);
clients[2].moves.endTurn();
await wait(100);
check('the turn cannot be ended early', G(0).phase === 'drawing');
await wait(800);
clients[2].moves.endTurn();
await wait(100);
check('after time is up another player ends the turn', G(0).phase === 'turnEnd');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);