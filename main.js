import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import QRCode from 'qrcode';
import { catalog } from './games/index.js';

const SERVER = import.meta.env.PROD
  ? location.origin
  : `${location.protocol}//${location.hostname}:8000`;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const matchID = params.get('match');
const gameID = params.get('game');
const view = params.get('view');
const entry = catalog.find((g) => g.id === gameID);

// Makes untrusted text (like nicknames) safe to put into HTML
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

async function api(game, path, body) {
  const res = await fetch(`${SERVER}/games/${game}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Which game does this room code belong to?
async function findGame(code) {
  for (const g of catalog) {
    try {
      const res = await fetch(`${SERVER}/games/${g.id}/${encodeURIComponent(code)}`);
      if (res.ok) return g.id;
    } catch (e) {
      /* try the next game */
    }
  }
  return null;
}

// Turns a player id into a safe display name
function makeNamer(client) {
  const names = {};
  (client.matchData || []).forEach((p) => (names[p.id] = p.name));
  return (id) => esc(names[id] || `Player ${Number(id) + 1}`);
}

function seatsHTML(client) {
  return (
    '<ul class="seats">' +
    (client.matchData || [])
      .map((p) => `<li>${p.name ? esc(p.name) : '<em>waiting…</em>'}</li>`)
      .join('') +
    '</ul>'
  );
}

function allJoined(client) {
  const seats = client.matchData || [];
  return seats.length > 0 && seats.every((p) => p.name);
}

// ---- Home: pick a game to host, or join with a code ----
function home() {
  const cards = catalog
    .map((g) => {
      const { minPlayers, maxPlayers } = g.game;
      let buttons = '';
      for (let n = minPlayers; n <= maxPlayers; n++) {
        const label = minPlayers === maxPlayers ? 'Start' : `${n} players`;
        buttons += `<button data-start="${g.id}" data-n="${n}">${label}</button> `;
      }
      return `<div class="player"><h3>${esc(g.name)}</h3><p>${esc(g.description)}</p>${buttons}</div>`;
    })
    .join('');
  app.innerHTML = `
    <h1>Party Games</h1>
    <h2>Host a game</h2>
    <p>Do this on the big screen.</p>
    <div class="players">${cards}</div>
    <h2>Join a game</h2>
    <p>Do this on your phone.</p>
    <input id="code" placeholder="ROOM CODE" maxlength="4" autocapitalize="characters" />
    <br /><button id="join">Join</button>
    <p id="err" class="warn"></p>`;
  app.querySelectorAll('[data-start]').forEach((b) => {
    b.onclick = async () => {
      const { matchID: newID } = await api(b.dataset.start, 'create', {
        numPlayers: Number(b.dataset.n),
      });
      location.search = `?game=${b.dataset.start}&match=${newID}&view=tv`;
    };
  });
  document.getElementById('join').onclick = async () => {
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (!code) return;
    const found = await findGame(code);
    if (found) location.search = `?game=${found}&match=${encodeURIComponent(code)}`;
    else document.getElementById('err').textContent = 'No room with that code.';
  };
}

// ---- TV view: lobby, then the game's public screen (spectator) ----
async function tv() {
  const joinURL = `${location.origin}/?game=${gameID}&match=${matchID}`;
  const qr = await QRCode.toDataURL(joinURL, { width: 280, margin: 2 });
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const client = Client({
    game: entry.game,
    matchID,
    multiplayer: SocketIO({ server: SERVER }),
  });
  client.start();
  client.subscribe((state) => {
    if (!state) {
      app.innerHTML = '<p>Connecting…</p>';
      return;
    }
    if (!allJoined(client)) {
      app.innerHTML = `
        <h1>${esc(entry.name)}</h1>
        <p>Go to this site on your phone and enter the code, or scan:</p>
        <p class="code">${esc(matchID)}</p>
        <img class="qr" src="${qr}" alt="QR code to join" />
        <p>${esc(joinURL)}</p>
        ${isLocal ? '<p class="warn">Phones cannot reach "localhost". Open this page using the Network address instead.</p>' : ''}
        ${seatsHTML(client)}`;
      return;
    }
    app.innerHTML = `
      <h1>${esc(entry.name)}</h1>
      <p>Room ${esc(matchID)}</p>
      ${entry.views.tv({ state, name: makeNamer(client) })}
      <p><a href="/">New game</a></p>`;
  });
}

// ---- Phone view ----
function joinForm() {
  app.innerHTML = `
    <h1>${esc(entry.name)}</h1>
    <p>Room ${esc(matchID)}</p>
    <input id="nick" placeholder="Your nickname" maxlength="12" />
    <br /><button id="go">Join</button>
    <p id="err" class="warn"></p>`;
  document.getElementById('go').onclick = async () => {
    const name = document.getElementById('nick').value.trim() || 'Player';
    try {
      const { playerID, playerCredentials } = await api(gameID, `${matchID}/join`, {
        playerName: name,
      });
      const seat = { playerID, credentials: playerCredentials };
      sessionStorage.setItem(`seat-${gameID}-${matchID}`, JSON.stringify(seat));
      playPhone(seat);
    } catch (e) {
      document.getElementById('err').textContent =
        'Could not join. Check the code, or the room may be full.';
    }
  };
}

function playPhone(seat) {
  let lastState = null;
  const client = Client({
    game: entry.game,
    matchID,
    playerID: seat.playerID,
    credentials: seat.credentials,
    multiplayer: SocketIO({ server: SERVER }),
  });

  function draw() {
    const state = lastState;
    if (!state) return;
    if (!allJoined(client)) {
      app.innerHTML = `<h2>You're in!</h2><p>Waiting for other players…</p>${seatsHTML(client)}`;
      return;
    }
    app.innerHTML = entry.views.phone({
      state,
      name: makeNamer(client),
      playerID: seat.playerID,
    });
    if (entry.views.bindPhone) {
      entry.views.bindPhone({
        root: app,
        state,
        playerID: seat.playerID,
        moves: client.moves,
        redraw: draw,
      });
    }
  }

  client.start();
  client.subscribe((state) => {
    if (!state) return;
    lastState = state;
    draw();
  });
}

function phone() {
  const saved = JSON.parse(
    sessionStorage.getItem(`seat-${gameID}-${matchID}`) || 'null'
  );
  if (saved) playPhone(saved);
  else joinForm();
}

function notFound() {
  app.innerHTML = '<p>That link looks incomplete. <a href="/">Back to start</a></p>';
}

// ---- Decide which screen to show ----
const run = !matchID ? home : !entry ? notFound : view === 'tv' ? tv : phone;
Promise.resolve(run()).catch((e) => {
  app.innerHTML = `<p>Something went wrong: ${esc(e.message)}</p>`;
});