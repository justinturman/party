const SYMBOL = { 0: 'X', 1: 'O' };

function status(state, name) {
  const { ctx } = state;
  if (ctx.gameover) {
    return ctx.gameover.draw ? "It's a draw!" : `${name(ctx.gameover.winner)} wins! 🎉`;
  }
  return `${name(ctx.currentPlayer)}'s turn (${SYMBOL[ctx.currentPlayer]})`;
}

function board(cells, canPlay) {
  return (
    '<div class="board">' +
    cells
      .map((c, i) => {
        const enabled = canPlay && c === null;
        return `<button class="cell" data-cell="${i}" ${enabled ? '' : 'disabled'}>${
          c === null ? '' : SYMBOL[c]
        }</button>`;
      })
      .join('') +
    '</div>'
  );
}

export const views = {
  // The shared screen: public information only
  tv: ({ state, name }) => `<h2>${status(state, name)}</h2>${board(state.G.cells, false)}`,

  // One player's phone
  phone: ({ state, name, playerID }) => {
    const myTurn = state.ctx.currentPlayer === playerID && !state.ctx.gameover;
    return `<h2>You are ${SYMBOL[playerID]}</h2>
      <p>${status(state, name)}</p>${board(state.G.cells, myTurn)}`;
  },

  // Wire up the phone's buttons after its HTML is on screen
  bindPhone: ({ root, moves }) => {
    root.querySelectorAll('[data-cell]').forEach((b) => {
      b.onclick = () => moves.clickCell(Number(b.dataset.cell));
    });
  },
};