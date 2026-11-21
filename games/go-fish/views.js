const ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const byRank = (a, b) => ORDER.indexOf(a.rank ?? a) - ORDER.indexOf(b.rank ?? b);
const RED = new Set(['♥', '♦']);

const card = (c) =>
  `<span class="card${RED.has(c.suit) ? ' red' : ''}">${c.rank}${c.suit}</span>`;

function describe(e, name) {
  switch (e.type) {
    case 'got':
      return `${name(e.who)} took ${e.count} ${e.rank}'s from ${name(e.from)}`;
    case 'fish':
      return `${name(e.who)} asked ${name(e.from)} for ${e.rank}'s. Go Fish!${
        e.empty ? ' (the pond is empty)' : e.lucky ? ' …and caught one!' : ''
      }`;
    case 'book':
      return `${name(e.who)} completed a book of ${e.rank}'s ✔`;
    case 'refill':
      return `${name(e.who)} ran out of cards and drew more`;
    default:
      return '';
  }
}

function logHTML(log, name, n) {
  return (
    '<ul class="log">' +
    log.slice(-n).reverse().map((e) => `<li>${describe(e, name)}</li>`).join('') +
    '</ul>'
  );
}

function winnerText(gameover, name) {
  const w = gameover.winners;
  return w.length === 1
    ? `${name(w[0])} wins! 🎉`
    : `It's a tie: ${w.map((id) => name(id)).join(', ')}`;
}

// What this phone has currently tapped (kept between redraws)
let sel = { target: null, rank: null };

export const views = {
  // Shared screen: counts and books only, never any cards
  tv: ({ state, name }) => {
    const { G, ctx } = state;
    const heading = ctx.gameover
      ? winnerText(ctx.gameover, name)
      : `${name(ctx.currentPlayer)}'s turn`;
    const players = Object.keys(G.handCounts)
      .map((id) => {
        const turn = id === ctx.currentPlayer && !ctx.gameover ? ' turn' : '';
        const books = G.books[id].length ? G.books[id].join(' ') : '–';
        return `<div class="player${turn}">
          <h3>${name(id)}</h3>
          <p>${G.handCounts[id]} cards</p>
          <p>Books: ${books}</p></div>`;
      })
      .join('');
    return `<h2>${heading}</h2>
      <div class="players">${players}</div>
      <p>🐟 Pond: ${G.deckCount} cards</p>
      ${logHTML(G.log, name, 8)}`;
  },

  // Phone: your own hand plus the controls
  phone: ({ state, name, playerID }) => {
    const { G, ctx } = state;
    const hand = [...G.myHand].sort(byRank);
    const myTurn = ctx.currentPlayer === playerID && !ctx.gameover;
    const targets = Object.keys(G.handCounts).filter(
      (id) => id !== playerID && G.handCounts[id] > 0
    );
    const ranks = [...new Set(hand.map((c) => c.rank))].sort(byRank);

    if (!myTurn) sel = { target: null, rank: null };
    if (!ranks.includes(sel.rank)) sel.rank = null;
    if (!targets.includes(sel.target)) sel.target = null;

    let controls;
    if (ctx.gameover) {
      controls = `<h3>${winnerText(ctx.gameover, name)}</h3>`;
    } else if (myTurn) {
      controls = `<h3>Your turn!</h3>
        <p>Ask who?</p>
        <div class="choices">${targets
          .map(
            (id) =>
              `<button data-target="${id}" class="${sel.target === id ? 'sel' : ''}">${name(id)} (${G.handCounts[id]})</button>`
          )
          .join('')}</div>
        <p>For which card?</p>
        <div class="choices">${ranks
          .map((r) => `<button data-rank="${r}" class="${sel.rank === r ? 'sel' : ''}">${r}</button>`)
          .join('')}</div>
        <button id="ask" ${sel.target && sel.rank ? '' : 'disabled'}>Ask!</button>`;
    } else {
      controls = `<h3>${name(ctx.currentPlayer)} is playing…</h3>`;
    }

    return `${controls}
      <h3>Your hand</h3>
      <div>${hand.map(card).join('')}</div>
      <p>Your books: ${G.books[playerID].length ? G.books[playerID].join(' ') : '–'}</p>
      ${logHTML(G.log, name, 3)}`;
  },

  bindPhone: ({ root, moves, redraw }) => {
    root.querySelectorAll('[data-target]').forEach((b) => {
      b.onclick = () => { sel.target = b.dataset.target; redraw(); };
    });
    root.querySelectorAll('[data-rank]').forEach((b) => {
      b.onclick = () => { sel.rank = b.dataset.rank; redraw(); };
    });
    const ask = root.querySelector('#ask');
    if (ask) {
      ask.onclick = () => {
        const { target, rank } = sel;
        sel = { target: null, rank: null };
        moves.askForRank(target, rank);
      };
    }
  },
};