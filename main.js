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

// ---- Remembering seats, so a player can return after closing the tab ----
// Stored on this device only. Nothing is sent to or kept on the server.
const STORE_KEY = 'party-sessions';
const KEEP_FOR = 12 * 60 * 60 * 1000; // forget entries after 12 hours

function loadSessions() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const fresh = {};
    for (const [k, v] of Object.entries(all)) {
      if (v && Date.now() - v.savedAt < KEEP_FOR) fresh[k] = v;
    }
    return fresh;
  } catch (e) {
    return {};
  }
}

function saveSession(key, data) {
  try {
    const all = loadSessions();
    all[key] = { ...data, savedAt: Date.now() };
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {
    /* storage can be blocked; recovery then simply won't work */
  }
}

function forgetSession(key) {
  try {
    const all = loadSessions();
    delete all[key];
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {
    /* ignore */
  }
}

const seatKey = () => `seat:${gameID}:${matchID}`;

// Does this room still exist on the server?
async function roomExists(game, code) {
  try {
    const res = await fetch(`${SERVER}/games/${game}/${encodeURIComponent(code)}`);
    return res.ok;
  } catch (e) {
    return false;
  }
}

function rememberSeat(seat, name) {
  sessionStorage.setItem(`seat-${gameID}-${matchID}`, JSON.stringify(seat)); // this tab
  saveSession(seatKey(), { game: gameID, match: matchID, name, seat }); // this device
}

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
    debug: params.get('debug') === '1', // hidden unless you add ?debug=1 to the address
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

function buildShell(onMove, extraHTML, who) {
  app.innerHTML = `<div class="bar"><span>${who ? `<strong>${esc(who)}</strong> · ` : ''}${esc(entry.name)} · Room ${esc(matchID)}</span><span id="bar-extra">${extraHTML || ''}</span></div>`;
  const frame = createFrame(onMove);
  app.appendChild(frame.iframe);
  return frame;
}

// ---- Home: pick a game to host, or join with a code ----
// ---- Home: a catalog of games in rows by category, plus join-by-code ----
function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#33334d';
}

function thumbHTML(g) {
  const img = g.thumbnail ? `<img src="${esc(SERVER + g.thumbnail)}" alt="" />` : '';
  return `${img}<span class="initial">${esc(g.name.charAt(0))}</span>`;
}

function playersText(g) {
  return g.minPlayers === g.maxPlayers
    ? `${g.minPlayers} players`
    : `${g.minPlayers}–${g.maxPlayers} players`;
}

function detailHTML(g) {
  let buttons = '';
  for (let n = g.minPlayers; n <= g.maxPlayers; n++) {
    const label = g.minPlayers === g.maxPlayers ? 'Start' : `${n} players`;
    buttons += `<button data-start="${esc(g.id)}" data-n="${n}">${label}</button> `;
  }
  return `<div class="detail-inner">
    <div class="detail-art" style="--accent:${safeColor(g.color)}">${g.thumbnail ? `<img src="${esc(SERVER + g.thumbnail)}" alt="" />` : ''}</div>
    <div class="detail-text">
      <button class="close" aria-label="Close">✕</button>
      <h3>${esc(g.name)}</h3>
      <p class="meta">${esc(g.category)} · ${playersText(g)}</p>
      <p>${esc(g.summary || g.description)}</p>
      <p><strong>Host this game on the big screen:</strong></p>
      ${buttons}
    </div>
  </div>`;
}

function home() {
  if (catalog.length === 0) {
    app.innerHTML =
      '<div class="page"><h1 class="banner-title"><img class="banner" src="/banner.jpg" alt="Party Games" /></h1><p>No games are installed yet.</p></div>';
    return;
  }

  // Group the games by category, categories in alphabetical order
  const groups = {};
  for (const g of catalog) {
    if (!groups[g.category]) groups[g.category] = [];
    groups[g.category].push(g);
  }
  const rows = Object.keys(groups)
    .sort()
    .map(
      (cat) => `
      <section class="row">
        <h2>${esc(cat)}</h2>
        <div class="strip">
          ${groups[cat]
            .map(
              (g) => `<button class="tile" data-id="${esc(g.id)}" style="--accent:${safeColor(g.color)}">
                <div class="thumb">${thumbHTML(g)}</div>
                <span class="tile-name">${esc(g.name)}</span>
              </button>`
            )
            .join('')}
        </div>
        <div class="detail" hidden></div>
      </section>`
    )
    .join('');

  app.innerHTML = `
        <div class="hero">
      <h1 class="banner-title"><img class="banner" src="/banner.jpg" alt="Party Games" /></h1>
      <p>Pick a game on the big screen. Join with a room code on your phone.</p>
      <div class="joinbar">
        <input id="code" placeholder="ROOM CODE" maxlength="4" autocapitalize="characters" />
        <button id="join">Join</button>
      </div>
      <p id="err" class="warn"></p>
      <div id="resume"></div>
    </div>
    ${rows}`;

  // If a thumbnail fails to load, the coloured tile with the initial shows instead
  app.querySelectorAll('.thumb img, .detail-art img').forEach((img) =>
    img.addEventListener('error', () => img.remove())
  );

  // Click a tile to expand its details; click it again (or the X) to close
  let openID = null;
  const closeAll = () => {
    app.querySelectorAll('.detail').forEach((d) => {
      d.hidden = true;
      d.innerHTML = '';
    });
    app.querySelectorAll('.tile.open').forEach((t) => t.classList.remove('open'));
  };
  app.querySelectorAll('.tile').forEach((tile) => {
    tile.onclick = () => {
      const id = tile.dataset.id;
      const wasOpen = openID === id;
      closeAll();
      if (wasOpen) {
        openID = null;
        return;
      }
      openID = id;
      const g = catalog.find((x) => x.id === id);
      const detail = tile.closest('.row').querySelector('.detail');
      detail.innerHTML = detailHTML(g);
      detail.hidden = false;
      tile.classList.add('open');
      detail.querySelectorAll('img').forEach((img) =>
        img.addEventListener('error', () => img.remove())
      );
      detail.querySelector('.close').onclick = () => {
        closeAll();
        openID = null;
      };
      detail.querySelectorAll('[data-start]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const { matchID: newID } = await api(b.dataset.start, 'create', {
              numPlayers: Number(b.dataset.n),
            });
            location.search = `?game=${b.dataset.start}&match=${newID}&view=tv`;
          } catch (e) {
            b.disabled = false;
            document.getElementById('err').textContent = 'Could not start the game. Try again.';
          }
        };
      });
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  });

  // Join by room code
  const codeInput = document.getElementById('code');
  const doJoin = async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;
    const found = await findGame(code);
    if (found) location.search = `?game=${found}&match=${encodeURIComponent(code)}`;
    else document.getElementById('err').textContent = 'No room with that code.';
  };
  document.getElementById('join').onclick = doJoin;
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  showResume();
}

// Offer to rejoin rooms this device was in, if they still exist
async function showResume() {
  const box = document.getElementById('resume');
  if (!box) return;
  const items = [];
  for (const [key, s] of Object.entries(loadSessions())) {
    const g = s && catalog.find((x) => x.id === s.game);
    if (!g) continue;
    if (!(await roomExists(s.game, s.match))) {
      forgetSession(key);
      continue;
    }
    items.push({ g, s });
  }
  if (!items.length) return;
  box.innerHTML =
    '<h3>Pick up where you left off</h3>' +
    items
      .map(
        ({ g, s }, i) =>
          `<button class="resume" data-i="${i}">${
            s.tv ? 'Resume hosting' : `Rejoin as ${esc(s.name || 'player')} in`
          } ${esc(g.name)} · Room ${esc(s.match)}</button>`
      )
      .join('<br />');
  box.querySelectorAll('.resume').forEach((b) => {
    b.onclick = () => {
      const { s } = items[Number(b.dataset.i)];
      const base = `?game=${encodeURIComponent(s.game)}&match=${encodeURIComponent(s.match)}`;
      if (s.tv) {
        location.search = `${base}&view=tv`;
      } else {
        sessionStorage.setItem(`seat-${s.game}-${s.match}`, JSON.stringify(s.seat));
        location.search = base;
      }
    };
  });
}

// ---- TV: lobby, then the game's public screen ----
async function tv() {
  const joinURL = `${location.origin}/?game=${gameID}&match=${matchID}`;
  const qr = await QRCode.toDataURL(joinURL, { width: 280, margin: 2 });
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const client = connect();
    saveSession(`tv:${gameID}:${matchID}`, { game: gameID, match: matchID, tv: true });
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
function joinForm(notice) {
  app.innerHTML = `
    <div class="page">
      <h1>${esc(entry.name)}</h1>
      <p>Room ${esc(matchID)}</p>
      ${notice ? `<p class="warn">${esc(notice)}</p>` : ''}
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
      rememberSeat(seat, name);
      playPhone(seat);
    } catch (e) {
      document.getElementById('err').textContent =
        'Could not join. Check the code, or the room may be full. You can still watch.';
    }
  };
}

async function phone() {
  // Same tab (for example a refresh): carry straight on
  const inTab = JSON.parse(
    sessionStorage.getItem(`seat-${gameID}-${matchID}`) || 'null'
  );
  if (inTab) {
    if (await roomExists(gameID, matchID)) return playPhone(inTab);
    sessionStorage.removeItem(`seat-${gameID}-${matchID}`);
    forgetSession(seatKey());
    return joinForm('That room has ended. You can join again if the host starts a new one.');
  }

  // A returning player on this device (the tab was closed): offer to continue
  const saved = loadSessions()[seatKey()];
  if (saved && saved.seat && (await roomExists(gameID, matchID))) {
    app.innerHTML = `
      <div class="page">
        <h1>${esc(entry.name)}</h1>
        <p>Room ${esc(matchID)}</p>
        <h2>Welcome back, ${esc(saved.name || 'player')}!</h2>
        <button id="continue">Continue as ${esc(saved.name || 'player')}</button>
        <br /><button id="other" class="secondary">Join as someone else</button>
      </div>`;
    document.getElementById('continue').onclick = () => {
      sessionStorage.setItem(`seat-${gameID}-${matchID}`, JSON.stringify(saved.seat));
      playPhone(saved.seat);
    };
    document.getElementById('other').onclick = () => joinForm();
    return;
  }
  if (saved) forgetSession(seatKey());
  joinForm();
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
        '<button id="flip">📺 TV view</button>',
        namesOf(player)[seat.playerID]
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