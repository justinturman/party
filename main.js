import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import QRCode from 'qrcode';

const SERVER = import.meta.env.PROD
  ? location.origin
  : `${location.protocol}//${location.hostname}:8000`;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const matchID = params.get('match');
const gameID = params.get('game');
const view = params.get('view'); // 'tv', 'watch', or nothing (a player's phone)

let catalog = [];
let entry = null;

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

// The browser no longer has the game's rules. This stand-in only knows the
// names of the moves, and passes them to the server, which holds the real rules.
function stubGame() {
  return {
    name: entry.id,
    minPlayers: entry.minPlayers,
    maxPlayers: entry.maxPlayers,
    moves: Object.fromEntries(
      entry.moves.map((m) => [m, { move: () => {}, client: false }])
    ),
  };
}

const connect = (extra = {}) =>
  Client({
    game: stubGame(),
    matchID,
    multiplayer: SocketIO({ server: SERVER }),
    ...extra,
  });

function namesOf(client) {
  const names = {};
  (client.matchData || []).forEach((p) => {
    names[p.id] = p.name || `Player ${p.id + 1}`;
  });
  return names;
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

// The message the game's screen receives
function stateMessage(viewName, playerID, client, state) {
  return JSON.parse(
    JSON.stringify({
      type: 'state',
      view: viewName, // 'public' or 'player'
      playerID,
      room: matchID,
      names: namesOf(client),
      state: { G: state.G, ctx: state.ctx },
    })
  );
}

// The sandboxed iframe that shows the game's own screens
function createFrame(onMove) {
  const iframe = document.createElement('iframe');
  iframe.className = 'game';
  iframe.setAttribute('sandbox', 'allow-scripts'); // no access to this page
  iframe.src = `${SERVER}/g/${entry.id}/`;
  let ready = false;
  let pending = null;
  const post = (msg) => iframe.contentWindow.postMessage(msg, '*');
  window.addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    const d = ev.data || {};
    if (d.type === 'ready') {
      ready = true;
      if (pending) post(pending);
    } else if (d.type === 'move' && typeof d.name === 'string') {
      onMove(d.name, Array.isArray(d.args) ? d.args : []);
    }
  });
  return {
    iframe,
    send(msg) {
      pending = msg;
      if (ready) post(msg);
    },
  };
}

function buildShell(onMove, extraHTML) {
  app.innerHTML = `<div class="bar"><span>${esc(entry.name)} · Room ${esc(matchID)}</span><span id="bar-extra">${extraHTML || ''}</span></div>`;
  const frame = createFrame(onMove);
  app.appendChild(frame.iframe);
  return frame;
}

// ---- Home: pick a game to host, or join with a code ----
function home() {
  if (catalog.length === 0) {
    app.innerHTML = '<div class="page"><h1>Party Games</h1><p>No games are installed yet.</p></div>';
    return;
  }
  const cards = catalog
    .map((g) => {
      let buttons = '';
      for (let n = g.minPlayers; n <= g.maxPlayers; n++) {
        const label = g.minPlayers === g.maxPlayers ? 'Start' : `${n} players`;
        buttons += `<button data-start="${esc(g.id)}" data-n="${n}">${label}</button> `;
      }
      return `<div class="player"><h3>${esc(g.name)}</h3><p>${esc(g.description)}</p>${buttons}</div>`;
    })
    .join('');
  app.innerHTML = `
    <div class="page">
      <h1>Party Games</h1>
      <h2>Host a game</h2>
      <p>Do this on the big screen.</p>
      <div class="players">${cards}</div>
      <h2>Join a game</h2>
      <p>Do this on your phone.</p>
      <input id="code" placeholder="ROOM CODE" maxlength="4" autocapitalize="characters" />
      <br /><button id="join">Join</button>
      <p id="err" class="warn"></p>
    </div>`;
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

// ---- TV: lobby, then the game's public screen ----
async function tv() {
  const joinURL = `${location.origin}/?game=${gameID}&match=${matchID}`;
  const qr = await QRCode.toDataURL(joinURL, { width: 280, margin: 2 });
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const client = connect();
  let frame = null;
  client.start();
  client.subscribe((state) => {
    if (!state) {
      if (!frame) app.innerHTML = '<div class="page"><p>Connecting…</p></div>';
      return;
    }
    if (!frame && !allJoined(client)) {
      app.innerHTML = `
        <div class="page">
          <h1>${esc(entry.name)}</h1>
          <p>Go to this site on your phone and enter the code, or scan:</p>
          <p class="code">${esc(matchID)}</p>
          <img class="qr" src="${qr}" alt="QR code to join" />
          <p>${esc(joinURL)}</p>
          ${isLocal ? '<p class="warn">Phones cannot reach "localhost". Open this page using the Network address instead.</p>' : ''}
          ${seatsHTML(client)}
        </div>`;
      return;
    }
    if (!frame) frame = buildShell(() => {}, '<a href="/">New game</a>');
    frame.send(stateMessage('public', null, client, state));
  });
}

// ---- Spectator: watches the public screen, takes no seat ----
function spectate() {
  const client = connect();
  let frame = null;
  client.start();
  client.subscribe((state) => {
    if (!state) return;
    if (!frame && !allJoined(client)) {
      app.innerHTML = `<div class="page"><h2>Waiting for players…</h2>${seatsHTML(client)}</div>`;
      return;
    }
    if (!frame) frame = buildShell(() => {}, 'Watching');
    frame.send(stateMessage('public', null, client, state));
  });
}

// ---- Phone: join form ----
function joinForm() {
  app.innerHTML = `
    <div class="page">
      <h1>${esc(entry.name)}</h1>
      <p>Room ${esc(matchID)}</p>
      <input id="nick" placeholder="Your nickname" maxlength="12" />
      <br /><button id="go">Join as player</button>
      <button id="watch" class="secondary">Just watch</button>
      <p id="err" class="warn"></p>
    </div>`;
  document.getElementById('watch').onclick = () => {
    location.search = `?game=${gameID}&match=${encodeURIComponent(matchID)}&view=watch`;
  };
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
        'Could not join. Check the code, or the room may be full. You can still watch.';
    }
  };
}

// ---- Phone: a seated player. Can flip between "my screen" and the TV view ----
function playPhone(seat) {
  const player = connect({ playerID: seat.playerID, credentials: seat.credentials });
  const watcher = connect(); // a second, spectator connection for the TV view
  const latest = { player: null, watcher: null };
  let showing = 'player';
  let frame = null;

  function draw() {
    if (!latest.player) return;
    if (!frame && !allJoined(player)) {
      app.innerHTML = `<div class="page"><h2>You're in!</h2><p>Waiting for other players…</p>${seatsHTML(player)}</div>`;
      return;
    }
    if (!frame) {
      frame = buildShell(
        (name, args) => {
          if (showing !== 'player') return;
          const fn = player.moves[name];
          if (typeof fn === 'function') fn(...args);
        },
        '<button id="flip">📺 TV view</button>'
      );
      document.getElementById('flip').onclick = () => {
        showing = showing === 'player' ? 'public' : 'player';
        document.getElementById('flip').textContent =
          showing === 'player' ? '📺 TV view' : '🎮 My screen';
        draw();
      };
    }
    if (showing === 'public') {
      if (latest.watcher) frame.send(stateMessage('public', null, watcher, latest.watcher));
    } else {
      frame.send(stateMessage('player', seat.playerID, player, latest.player));
    }
  }

  player.start();
  watcher.start();
  player.subscribe((state) => {
    if (!state) return;
    latest.player = state;
    draw();
  });
  watcher.subscribe((state) => {
    if (!state) return;
    latest.watcher = state;
    if (showing === 'public') draw();
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
  app.innerHTML =
    '<div class="page"><p>That link looks incomplete or the game is not installed. <a href="/">Back to start</a></p></div>';
}

async function main() {
  try {
    const res = await fetch(`${SERVER}/catalog.json`);
    catalog = await res.json();
  } catch (e) {
    app.innerHTML = '<div class="page"><p>Cannot reach the game server.</p></div>';
    return;
  }
  entry = catalog.find((g) => g.id === gameID) || null;
  if (!matchID) return home();
  if (!entry) return notFound();
  if (view === 'tv') return tv();
  if (view === 'watch') return spectate();
  return phone();
}

main().catch((e) => {
  app.innerHTML = `<div class="page"><p>Something went wrong: ${esc(e.message)}</p></div>`;
});