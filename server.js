import boardgameServer from 'boardgame.io/dist/cjs/server.js';
const { Server, Origins } = boardgameServer;
import { TicTacToe } from './games/tic-tac-toe/game.js';

const server = Server({
  games: [TicTacToe],
  origins: [Origins.LOCALHOST],
});

server.run(8000, () => {
  console.log('Server running on http://localhost:8000');
});