import { game as GoFish } from './games/go-fish/server.js';

const shuffle = (a) => [...a].sort(() => Math.random() - 0.5);

function newGame(numPlayers) {
  const ctx = { numPlayers, currentPlayer: '0' };
  const G = GoFish.setup({ ctx, random: { Shuffle: shuffle } });
  return { G, ctx };
}

// Test 1: is hidden information really hidden?
{
  const { G, ctx } = newGame(3);
  const phone0 = GoFish.playerView({ G, ctx, playerID: '0' });
  const tv = GoFish.playerView({ G, ctx, playerID: null });
  console.log('Phone 0 hand size:', phone0.myHand.length);
  console.log('TV myHand (should be null):', tv.myHand);
  console.log('TV view contains deck or hands? (should be false):', 'deck' in tv || 'hands' in tv);
  console.log('Phone view contains deck or hands? (should be false):', 'deck' in phone0 || 'hands' in phone0);
}

// Test 2: play 300 random games and check nothing breaks
function play(numPlayers) {
  const { G, ctx } = newGame(numPlayers);
  const events = { endTurn: ({ next }) => { ctx.currentPlayer = next; } };
  for (let step = 0; step < 5000; step++) {
    if (GoFish.endIf({ G, ctx })) return step;
    const me = ctx.currentPlayer;
    const myHand = G.hands[me];
    const targets = Object.keys(G.hands).filter((id) => id !== me && G.hands[id].length > 0);
    if (myHand.length === 0 || targets.length === 0) throw new Error('Stuck: no legal move');
    const rank = myHand[Math.floor(Math.random() * myHand.length)].rank;
    const target = targets[Math.floor(Math.random() * targets.length)];
    const result = GoFish.moves.askForRank.move({ G, ctx, playerID: me, events }, target, rank);
    if (result === 'INVALID_MOVE') throw new Error('A legal move was rejected');
    const total =
      G.deck.length +
      Object.values(G.hands).flat().length +
      4 * Object.values(G.books).flat().length;
    if (total !== 52) throw new Error('Cards went missing!');
  }
  throw new Error('Game did not finish');
}

let longest = 0;
for (let i = 0; i < 300; i++) longest = Math.max(longest, play(2 + (i % 5)));
console.log('300 random games finished OK. Longest game:', longest, 'moves');