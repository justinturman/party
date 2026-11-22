import boardgameClient from 'boardgame.io/dist/cjs/client.js';
const { Client } = boardgameClient;
import { game as TicTacToe } from './games/tic-tac-toe/server.js';

const client = Client({ game: TicTacToe });
client.start();

// Players alternate: player 0 takes squares 0, 1, 2 (the top row)
const moves = [0, 3, 1, 4, 2];
for (const cell of moves) {
  client.moves.clickCell(cell);
}

const state = client.getState();
console.log(state.G.cells);
console.log(state.ctx.gameover);