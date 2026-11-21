const INVALID_MOVE = 'INVALID_MOVE';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

const plain = (c) => ({ rank: c.rank, suit: c.suit });

function makeDeck() {
  const deck = [];
  for (const rank of RANKS) for (const suit of SUITS) deck.push({ rank, suit });
  return deck;
}

// If a player holds all 4 cards of a rank, move them into their "books"
function makeBooks(G, id) {
  for (const rank of RANKS) {
    const count = G.hands[id].filter((c) => c.rank === rank).length;
    if (count === 4) {
      G.hands[id] = G.hands[id].filter((c) => c.rank !== rank);
      G.books[id].push(rank);
      G.log.push({ type: 'book', who: id, rank });
    }
  }
}

// A player with no cards draws up to 5 from the pond (if any are left)
function refillEmptyHands(G) {
  let changed = true;
  while (changed && G.deck.length > 0) {
    changed = false;
    for (const id of Object.keys(G.hands)) {
      if (G.hands[id].length === 0 && G.deck.length > 0) {
        const n = Math.min(5, G.deck.length);
        const drawn = G.deck.splice(-n).map(plain);
        G.hands[id].push(...drawn);
        G.log.push({ type: 'refill', who: id });
        makeBooks(G, id);
        changed = true;
      }
    }
  }
}

// Next player in seat order who still has cards
function nextPlayer(G, ctx, current) {
  const n = ctx.numPlayers;
  for (let i = 1; i <= n; i++) {
    const id = String((Number(current) + i) % n);
    if (G.hands[id].length > 0) return id;
  }
  return current;
}

export const GoFish = {
  name: 'go-fish',
  minPlayers: 2,
  maxPlayers: 6,

  setup: ({ ctx, random }) => {
    const deck = random.Shuffle(makeDeck());
    const handSize = ctx.numPlayers <= 3 ? 7 : 5;
    const G = { deck, hands: {}, books: {}, log: [] };
    for (let i = 0; i < ctx.numPlayers; i++) {
      const id = String(i);
      G.hands[id] = deck.splice(0, handSize);
      G.books[id] = [];
    }
    for (const id of Object.keys(G.hands)) makeBooks(G, id);
    return G;
  },

  // THE PRIVACY RULE: what each device is allowed to see.
  // The deck and other players' hands never leave the server.
  playerView: ({ G, playerID }) => {
    const handCounts = {};
    for (const id of Object.keys(G.hands)) handCounts[id] = G.hands[id].length;
    const isPlayer = playerID !== null && playerID !== undefined;
    return {
      deckCount: G.deck.length,
      handCounts,
      books: G.books,
      log: G.log,
      myHand: isPlayer ? G.hands[playerID] : null, // the TV gets null
    };
  },

  moves: {
    askForRank: {
      client: false, // needs secret info, so only the server runs it
      move: ({ G, ctx, playerID, events }, targetID, rank) => {
        const myHand = G.hands[playerID];
        const theirHand = G.hands[targetID];
        if (!theirHand || targetID === playerID) return INVALID_MOVE;
        if (theirHand.length === 0) return INVALID_MOVE;
        if (!myHand.some((c) => c.rank === rank)) return INVALID_MOVE; // must hold the rank

        const taken = theirHand.filter((c) => c.rank === rank).map(plain);
        let again = false;

        if (taken.length > 0) {
          G.hands[targetID] = theirHand.filter((c) => c.rank !== rank);
          myHand.push(...taken);
          G.log.push({ type: 'got', who: playerID, from: targetID, rank, count: taken.length });
          again = true; // a successful ask means you go again
        } else if (G.deck.length > 0) {
          const card = plain(G.deck.pop());
          myHand.push(card);
          const lucky = card.rank === rank;
          G.log.push({ type: 'fish', who: playerID, from: targetID, rank, lucky });
          again = lucky; // drew the card you asked for: go again
        } else {
          G.log.push({ type: 'fish', who: playerID, from: targetID, rank, lucky: false, empty: true });
        }

        for (const id of Object.keys(G.hands)) makeBooks(G, id);
        refillEmptyHands(G);
        if (G.log.length > 30) G.log.splice(0, G.log.length - 30);

        const booksTotal = Object.values(G.books).reduce((n, b) => n + b.length, 0);
        if (booksTotal === 13) return; // game over, endIf takes it from here

        if (!again || G.hands[playerID].length === 0) {
          events.endTurn({ next: nextPlayer(G, ctx, playerID) });
        }
      },
    },
  },

  endIf: ({ G }) => {
    const booksTotal = Object.values(G.books).reduce((n, b) => n + b.length, 0);
    if (booksTotal < 13) return;
    const best = Math.max(...Object.values(G.books).map((b) => b.length));
    return { winners: Object.keys(G.books).filter((id) => G.books[id].length === best) };
  },
};