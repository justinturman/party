import { TicTacToe } from './tic-tac-toe/game.js';
import { views as ticTacToeViews } from './tic-tac-toe/views.js';
import { GoFish } from './go-fish/game.js';
import { views as goFishViews } from './go-fish/views.js';
import { Trivia } from './trivia/game.js';
import { views as triviaViews } from './trivia/views.js';

// To add a game: build game.js + views.js, then add one entry here.
export const catalog = [
  {
    id: 'tic-tac-toe', // must match the game's `name`
    name: 'Tic-Tac-Toe',
    description: 'The classic. Three in a row wins.',
    game: TicTacToe,
    views: ticTacToeViews,
  },
  {
    id: 'go-fish',
    name: 'Go Fish',
    description: 'Collect sets of four by asking other players for cards.',
    game: GoFish,
    views: goFishViews,
  },
  {
    id: 'trivia',
    name: 'Trivia',
    description: 'Take turns answering multiple-choice questions. Harder questions are worth more points.',
    game: Trivia,
    views: triviaViews,
  },
];