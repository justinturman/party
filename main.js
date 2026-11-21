import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { TicTacToe } from './games/tic-tac-toe/game.js';

const SERVER = `${location.protocol}//${location.hostname}:8000`;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const matchID = params.get('match');
const view = params.get('view');
const SYMBOL = { 0: 'X', 1: 'O' };

// Talks to the server's built-in "lobby" (create a match, join a seat)
async function api(path, body) {
  const res = await fetch(`${SERVER}/games/tic-tac-toe/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function boardHTML(cells, canPlay) {
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

function statusText(state, client) {
  const names = {};
  (client.matchData || []).forEach((p) => (names[p.id] = p.name));
  const name = (id) => names[id] || `Player ${id}`;
  const { ctx } = state;
  if (ctx.gameover) {
    return ctx.gameover.draw ? "It's a draw!" : `${name(ctx.gameover.winner)} wins! 🎉`;
  }
  return `${name(ctx.currentPlayer)}'s turn (${SYMBOL[ctx.currentPlayer]})`;
}

// ---- Home: start a new game ----
function home() {
  app.innerHTML = '<h1>Party Games</h1><button id="create">Start Tic-Tac-Toe</button>';
  document.getElementById('create').onclick = async () => {
    const { matchID } = await api('create', { numPlayers: 2 });
    location.search = `?match=${matchID}&view=tv`;
  };
}

// ---- TV view: public, read-only (no playerID = spectator) ----
function tv() {
  const joinURL = `${location.origin}/?match=${matchID}`;
  const client = Client({
    game: TicTacToe,
    matchID,
    multiplayer: SocketIO({ server: SERVER }),
  });
  client.start();
  client.subscribe((state) => {
    if (!state) {
      app.innerHTML = '<p>Connecting…</p>';
      return;
    }
    app.innerHTML = `
      <h1>Tic-Tac-Toe</h1>
      <p>Players join at: <a href="${joinURL}" target="_blank">${joinURL}</a></p>
      <h2>${statusText(state, client)}</h2>
      ${boardHTML(state.G.cells, false)}`;
  });
}

// ---- Phone view: personal, with controls ----
async function phone() {
  const key = `seat-${matchID}`;
  let seat = JSON.parse(sessionStorage.getItem(key) || 'null');
  if (!seat) {
    const name = prompt('Your nickname?') || 'Player';
    const { playerID, playerCredentials } = await api(`${matchID}/join`, {
      playerName: name,
    });
    seat = { playerID, credentials: playerCredentials };
    sessionStorage.setItem(key, JSON.stringify(seat));
  }
  const client = Client({
    game: TicTacToe,
    matchID,
    playerID: seat.playerID,
    credentials: seat.credentials,
    multiplayer: SocketIO({ server: SERVER }),
  });
  client.start();
  client.subscribe((state) => {
    if (!state) return;
    const myTurn = state.ctx.currentPlayer === seat.playerID && !state.ctx.gameover;
    app.innerHTML = `
      <h2>You are ${SYMBOL[seat.playerID]}</h2>
      <p>${statusText(state, client)}</p>
      ${boardHTML(state.G.cells, myTurn)}`;
    app.querySelectorAll('[data-cell]').forEach((b) => {
      b.onclick = () => client.moves.clickCell(Number(b.dataset.cell));
    });
  });
}

// ---- Decide which screen to show ----
const run = !matchID ? home : view === 'tv' ? tv : phone;
Promise.resolve(run()).catch((e) => {
  app.innerHTML = `<p>Something went wrong: ${e.message}</p>`;
});