import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import QRCode from 'qrcode';

const SERVER = import.meta.env.PROD
  ? location.origin
  : `${location.protocol}//${location.hostname}:8000`;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
// A room link looks like  site.com/ABCD  (four letters). The code is all that is needed:
// the server knows which game it belongs to.
const matchID = ((location.pathname.match(/^\/([A-Za-z]{4})\/?$/) || [])[1] || '').toUpperCase() || null;
let gameID = null; // found from the code, see main()

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

// Which screen this tab shows for a room: 'tv' (the big screen), 'watch' (a spectator),
// or nothing (a player's phone). It is remembered per tab, so the address stays plain
// site.com/ABCD and anyone who opens that address gets the player screen.
const roleKey = (code) => `party-role-${code}`;
function getRole(code) {
  try {
    return sessionStorage.getItem(roleKey(code));
  } catch (e) {
    return null;
  }
}
function setRole(code, role) {
  try {
    if (role) sessionStorage.setItem(roleKey(code), role);
    else sessionStorage.removeItem(roleKey(code));
  } catch (e) {
    /* storage can be blocked; the tab then shows the player screen */
  }
}

// ---- Host key: proves this TV created the room, so only it can close the room ----
// Made in the browser (getRandomValues also works on plain http://192.168.x.x addresses,
// where crypto.randomUUID does not). Kept per tab, and also in the saved TV session so
// "Resume hosting" in a new tab keeps the right to close the room.
const hostKeyName = (code) => `party-host-${code}`;
function newHostKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function getHostKey(code) {
  try {
    return (
      sessionStorage.getItem(hostKeyName(code)) ||
      (loadSessions()[`tv:${gameID}:${code}`] || {}).hostKey ||
      ''
    );
  } catch (e) {
    return '';
  }
}

// Which game does this room code belong to? Returns the game's id, or null if there is no such room.
async function roomGame(code) {
  const res = await fetch(`${SERVER}/room/${encodeURIComponent(code)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('server');
  const data = await res.json();
  return data.game || null;
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

// Who has joined, and who is still connected (games like Find It list these)
function rosterOf(client) {
  return (client.matchData || [])
    .filter((p) => p.name)
    .map((p) => ({ id: String(p.id), name: p.name, connected: p.isConnected !== false }));
}

function seatsHTML(client) {
  const seats = client.matchData || [];
  if (entry && entry.openJoin) {
    const joined = seats.filter((p) => p.name);
    return (
      '<ul class="seats">' +
      (joined.length
        ? joined.map((p) => `<li>${esc(p.name)}</li>`).join('')
        : '<li><em>Waiting for the first player…</em></li>') +
      '</ul>'
    );
  }
  return (
    '<ul class="seats">' +
    seats.map((p) => `<li>${p.name ? esc(p.name) : '<em>waiting…</em>'}</li>`).join('') +
    '</ul>'
  );
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
      players: rosterOf(client),
      state: { G: state.G, ctx: state.ctx },
    })
  );
}

// A panel on the TV with the room code and QR code, so people can join mid-game
function addJoinPanel(joinURL, qr) {
  const panel = document.createElement('div');
  panel.id = 'joinpanel';
  panel.hidden = true;
  panel.innerHTML = `<div class="joincard">
      <p>Go to this site on your phone and enter the code, or scan:</p>
      <p class="code">${esc(matchID)}</p>
      <img class="qr" src="${qr}" alt="QR code to join" />
      <p>${esc(joinURL)}</p>
      <button id="joinclose">Close</button></div>`;
  app.appendChild(panel);
  document.getElementById('joinbtn').onclick = () => { panel.hidden = false; };
  document.getElementById('joinclose').onclick = () => { panel.hidden = true; };
}

const LEAVE_WAIT_MS = 500; // how long a game has to object when a player taps Leave

let currentSeat = null; // the seat this phone holds, once it has joined

// Leaving an open-join game gives the seat back to the server, so the room's player count
// drops and the TV can go back to its join screen when nobody is left. (This is our own
// endpoint, not boardgame.io's "leave", because that one deletes the whole room when the
// last player leaves, and the TV is still waiting in it.)
let leaving = false;
async function goHome() {
  if (leaving) return;
  leaving = true;
  // Give a game's own "leave" move a moment to reach the server first
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (currentSeat && entry && entry.openJoin) {
    const seat = currentSeat;
    currentSeat = null;
    try {
      sessionStorage.removeItem(`seat-${gameID}-${matchID}`);
    } catch (e) {
      /* ignore */
    }
    forgetSession(seatKey()); // the seat is gone, so don't offer to rejoin it later
    try {
      // Wait (briefly) for the server, so the seat is free before this phone disconnects.
      // text/plain keeps this a "simple" request: no CORS preflight, even while developing.
      await Promise.race([
        fetch(`${SERVER}/vacate/${matchID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ playerID: seat.playerID, credentials: seat.credentials }),
          keepalive: true,
        }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch (e) {
      /* the page leaves anyway */
    }
  }
  location.href = '/';
}

// The room has been closed (the TV left the game): everybody goes back to the home screen.
function roomClosed() {
  if (leaving) return;
  leaving = true;
  try {
    sessionStorage.removeItem(`seat-${gameID}-${matchID}`);
    sessionStorage.setItem('party-notice', 'The host ended that game.');
  } catch (e) {
    /* ignore */
  }
  forgetSession(seatKey());
  forgetSession(`tv:${gameID}:${matchID}`);
  location.href = '/';
}

// This phone's seat was given up by the server (it was offline for too long): offer a fresh join.
const SEAT_NOTICE = 'Your seat was given up while you were away. You can join again.';
function seatLost() {
  if (leaving) return;
  leaving = true;
  try {
    sessionStorage.removeItem(`seat-${gameID}-${matchID}`);
    sessionStorage.setItem('party-seat-notice', SEAT_NOTICE);
  } catch (e) {
    /* ignore */
  }
  forgetSession(seatKey());
  location.reload();
}
function takeSeatNotice() {
  try {
    const n = sessionStorage.getItem('party-seat-notice');
    sessionStorage.removeItem('party-seat-notice');
    return n || undefined;
  } catch (e) {
    return undefined;
  }
}

// The TV leaves ("New game"): the room is deleted, which sends every player home too.
async function endGame() {
  if (leaving) return;
  leaving = true;
  const hostKey = getHostKey(matchID); // read before the saved session is forgotten
  forgetSession(`tv:${gameID}:${matchID}`);
  try {
    await Promise.race([
      fetch(`${SERVER}/close/${matchID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ hostKey }),
        keepalive: true,
      }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (e) {
    /* the page leaves anyway */
  }
  location.href = '/';
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.newgame');
  if (!a) return;
  e.preventDefault();
  if (!confirm('End this game for everyone and go back to the game list?')) return;
  endGame();
});

// The server does not announce it when a seat is freed (or the room is closed), so the
// screens also ask about the room every few seconds and redraw when the seat list changed.
function watchSeats(clients, redraw, onSeats) {
  // One poll serves every client of this screen (a phone has a player and a TV-view client)
  const list = Array.isArray(clients) ? clients : [clients];
  const names = (players) => JSON.stringify((players || []).map((p) => [p.id, p.name || '']));
  setInterval(async () => {
    try {
      const res = await fetch(`${SERVER}/games/${gameID}/${matchID}`);
      if (res.status === 404) return roomClosed(); // the TV left, so the room is gone
      if (!res.ok || !entry.openJoin) return;
      const m = await res.json();
      if (!Array.isArray(m.players)) return;
      if (onSeats) onSeats(m.players);
      const fresh = names(m.players);
      if (list.every((c) => names(c.matchData) === fresh)) return;
      list.forEach((c) => {
        c.matchData = m.players;
      });
      redraw();
    } catch (e) {
      /* try again next time */
    }
  }, 2500);
}

// The sandboxed iframe that shows the game's own screens
function createFrame(onMove) {
  const iframe = document.createElement('iframe');
  iframe.className = 'game';
  iframe.setAttribute('sandbox', 'allow-scripts'); // no access to this page
  iframe.src = `${SERVER}/g/${entry.id}/`;
  let ready = false;
  let pending = null;
  let leaveTimer = null;
  const post = (msg) => iframe.contentWindow.postMessage(msg, '*');
  window.addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    const d = ev.data || {};
    if (d.type === 'ready') {
      ready = true;
      if (pending) post(pending);
    } else if (d.type === 'move' && typeof d.name === 'string') {
      onMove(d.name, Array.isArray(d.args) ? d.args : []);
    } else if (d.type === 'leave-veto') {
      clearTimeout(leaveTimer); // the game is handling it and will send "leave" when the player confirms
    } else if (d.type === 'leave') {
      goHome(); // a game's own "Leave" button takes the player back to the catalog
    }
  });
  return {
    iframe,
    send(msg) {
      pending = msg;
      if (ready) post(msg);
    },
    // Tells the game the player wants to leave. If the game does not object, they leave.
    requestLeave() {
      if (!ready) return goHome();
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(goHome, LEAVE_WAIT_MS);
      post({ type: 'leaving' });
    },
  };
}

const HAMBURGER =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const menuButtonHTML = () =>
  `<button id="menubtn" class="menubtn" type="button" aria-label="Menu" aria-haspopup="true" aria-expanded="false">${HAMBURGER}</button>`;
const barLeft = (who) =>
  `<span>${who ? `<strong>${esc(who)}</strong> · ` : ''}${esc(entry.name)} · Room ${esc(matchID)}</span>`;

function buildShell(onMove, extraHTML, who, withMenu) {
  app.innerHTML = `<div class="bar">${barLeft(who)}<span id="bar-extra">${extraHTML || ''}${withMenu ? menuButtonHTML() : ''}</span></div>`;
  const frame = createFrame(onMove);
  app.appendChild(frame.iframe);
  if (withMenu) phoneMenu.attach(frame);
  return frame;
}

// ---- The phone's menu: Leave, Help, Join, About ----
// The menu and its screens live on the page itself (not inside #app), so they
// survive the game redrawing the screen underneath them.
let joinQR = null; // the QR code picture, made the first time it is needed
let aboutHTML = null; // the About page, fetched the first time it is needed

const phoneMenu = {
  frame: null, // the game's iframe, once it exists (null on the "waiting for players" screen)
  // Call after a top bar with a menu button has been drawn
  attach(frame) {
    this.frame = frame;
    makeMenuParts();
    const btn = document.getElementById('menubtn');
    if (btn) btn.onclick = () => (menuIsOpen() ? closeMenu() : openMenu());
  },
};

function makeMenuParts() {
  if (document.getElementById('pmenu')) return;
  const back = document.createElement('div');
  back.id = 'pmenuback';
  back.hidden = true;
  const menu = document.createElement('div');
  menu.id = 'pmenu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-act="leave">🚪 Leave</button>
    <button type="button" role="menuitem" data-act="help">❓ Help</button>
    <button type="button" role="menuitem" data-act="join">➕ Join</button>
    <button type="button" role="menuitem" data-act="about">ℹ️ About</button>`;
  document.body.append(back, menu);
  // The game swallows taps, so this invisible layer catches taps outside the menu
  back.onclick = closeMenu;
  menu.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    closeMenu();
    runMenuAction(b.dataset.act);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('poverlay')) closeOverlay();
    else closeMenu();
  });
}

function menuIsOpen() {
  const m = document.getElementById('pmenu');
  return !!m && !m.hidden;
}

function openMenu() {
  const menu = document.getElementById('pmenu');
  const back = document.getElementById('pmenuback');
  if (!menu || !back) return;
  menu.hidden = false;
  back.hidden = false;
  const btn = document.getElementById('menubtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('button');
  if (first) first.focus();
}

function closeMenu() {
  const menu = document.getElementById('pmenu');
  const back = document.getElementById('pmenuback');
  if (menu) menu.hidden = true;
  if (back) back.hidden = true;
  const btn = document.getElementById('menubtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function runMenuAction(act) {
  if (act === 'leave') {
    if (phoneMenu.frame) phoneMenu.frame.requestLeave();
    else goHome();
  } else if (act === 'help') showHelp();
  else if (act === 'join') showJoin();
  else if (act === 'about') showAbout();
}

// A floating full-screen page with a title and an X
function openOverlay(title, fill, flush) {
  closeOverlay();
  const o = document.createElement('div');
  o.id = 'poverlay';
  o.className = 'poverlay';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-modal', 'true');
  o.setAttribute('aria-label', title);
  o.innerHTML = `<div class="ov-head"><h2>${esc(title)}</h2><button type="button" class="ov-close" aria-label="Close">✕</button></div><div class="ov-body${flush ? ' flush' : ''}"></div>`;
  document.body.appendChild(o);
  const close = o.querySelector('.ov-close');
  close.onclick = closeOverlay;
  close.focus();
  fill(o.querySelector('.ov-body'));
}

function closeOverlay() {
  const o = document.getElementById('poverlay');
  if (!o) return;
  o.remove();
  const btn = document.getElementById('menubtn');
  if (btn) btn.focus();
}

function showHelp() {
  const raw = entry && typeof entry.help === 'string' ? entry.help : '';
  // In game.json a new line is written \n. A doubled backslash is accepted too.
  const text = raw.replace(/\\n/g, '\n').trim();
  openOverlay('Help', (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'ov-wrap';
    const sub = document.createElement('p');
    sub.className = 'ov-sub';
    sub.textContent = entry.name;
    const content = document.createElement('div');
    if (text) {
      content.className = 'ov-text';
      content.textContent = text; // plain text only: nothing in it is ever treated as HTML
    } else {
      content.className = 'ov-muted';
      content.textContent = 'There is no Help content for this game yet.';
    }
    wrap.append(sub, content);
    body.appendChild(wrap);
  });
}

function showJoin() {
  const joinURL = `${location.origin}/${matchID}`;
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  openOverlay('Join', (body) => {
    const paint = (qr) => {
      body.innerHTML = `<div class="ov-wrap" style="text-align:center">
        <p>Go to this site on your phone and enter the code, or scan:</p>
        <p class="code">${esc(matchID)}</p>
        ${qr ? `<img class="qr" src="${qr}" alt="QR code to join" />` : '<p class="ov-muted">Making the QR code…</p>'}
        <p>${esc(joinURL)}</p>
        ${isLocal ? '<p class="warn">Phones cannot reach "localhost". Open this page using the Network address instead.</p>' : ''}
      </div>`;
    };
    paint(joinQR);
    if (!joinQR) {
      QRCode.toDataURL(joinURL, { width: 280, margin: 2 })
        .then((url) => {
          joinQR = url;
          if (body.isConnected) paint(url);
        })
        .catch(() => {});
    }
  });
}

function showAbout() {
  openOverlay(
    'About',
    (body) => {
      const message = (text) => {
        body.innerHTML = `<div class="ov-wrap" style="padding:1rem"><p class="ov-muted">${text}</p></div>`;
      };
      const show = (html) => {
        const f = document.createElement('iframe');
        f.className = 'ov-about';
        f.title = 'About Party Games';
        // No scripts, and links open in a new tab, so the page cannot touch this one
        f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        f.srcdoc = html;
        body.innerHTML = '';
        body.appendChild(f);
      };
      if (aboutHTML) return show(aboutHTML);
      message('Loading…');
      fetch('/about.html')
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('missing'))))
        .then((text) => {
          // While developing, a missing file can come back as the app's own start page
          if (text.includes('/main.js')) throw new Error('missing');
          aboutHTML = text;
          if (body.isConnected) show(text);
        })
        .catch(() => {
          if (body.isConnected) message('The About page could not be loaded.');
        });
    },
    true
  );
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
  if (g.openJoin) return 'Players can join any time';
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

// ---- The rows of games: a scrolling carousel with arrows ----
const CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const smoothBehavior = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

function setupCarousel(box) {
  const strip = box.querySelector('.strip');
  const left = box.querySelector('.arrow.left');
  const right = box.querySelector('.arrow.right');

  // Show an arrow only when there is more to see in that direction
  const update = () => {
    const max = strip.scrollWidth - strip.clientWidth;
    box.classList.toggle('can-left', strip.scrollLeft > 2);
    box.classList.toggle('can-right', strip.scrollLeft < max - 2);
  };
  const page = (dir) =>
    strip.scrollBy({ left: dir * Math.max(240, strip.clientWidth * 0.8), behavior: smoothBehavior() });
  left.onclick = () => page(-1);
  right.onclick = () => page(1);
  strip.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(strip);
  else window.addEventListener('resize', update);
  update();

  // Drag with the mouse (touch screens already scroll with a finger)
  let drag = null;
  let moved = false;
  strip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, start: strip.scrollLeft };
    moved = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!moved && Math.abs(dx) > 6) {
      moved = true;
      strip.classList.add('dragging');
    }
    if (moved) strip.scrollLeft = drag.start - dx;
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    strip.classList.remove('dragging');
    setTimeout(() => {
      moved = false; // after the click that follows a drag
    }, 0);
  });
  // A drag must not count as a click on the tile underneath
  strip.addEventListener(
    'click',
    (e) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  strip.addEventListener('dragstart', (e) => e.preventDefault());
}

// Makes sure a tile that was just opened is fully inside its row
function revealTile(tile) {
  const strip = tile.closest('.strip');
  if (!strip) return;
  const s = strip.getBoundingClientRect();
  const t = tile.getBoundingClientRect();
  const margin = 40; // clear of the fade at the edge
  let dx = 0;
  if (t.left < s.left + margin) dx = t.left - s.left - margin;
  else if (t.right > s.right - margin) dx = t.right - s.right + margin;
  if (dx) strip.scrollBy({ left: dx, behavior: smoothBehavior() });
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
        <div class="carousel">
          <button class="arrow left" type="button" aria-label="Scroll left">${CHEVRON_LEFT}</button>
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
          <button class="arrow right" type="button" aria-label="Scroll right">${CHEVRON_RIGHT}</button>
        </div>
        <div class="detail" hidden></div>
      </section>`
    )
    .join('');

  app.innerHTML = `
    <div class="hero">
      <h1 class="banner-title"><img class="banner" src="/banner.jpg" alt="Party Games" /></h1>
      <p>Pick a game on the big screen. Join with a room code on your phone.</p>
      <form id="joinform" class="joinbar" autocomplete="off">
        <input id="code" placeholder="ROOM CODE" maxlength="4" autocapitalize="characters" enterkeyhint="go" />
        <button id="join" type="submit">Join</button>
      </form>
      <p id="err" class="warn"></p>
      <div id="resume"></div>
    </div>
    ${rows}
    <p class="footer"><a href="/about.html">About &amp; privacy</a></p>`;

  try {
    const notice = sessionStorage.getItem('party-notice');
    if (notice) {
      sessionStorage.removeItem('party-notice');
      document.getElementById('err').textContent = notice;
    }
  } catch (e) {
    /* ignore */
  }

  app.querySelectorAll('.carousel').forEach(setupCarousel);

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
      revealTile(tile);
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
            // Claim the room: the key is what later lets this TV (and only this TV) close it
            const hostKey = newHostKey();
            const claim = await fetch(`${SERVER}/host/${newID}`, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body: JSON.stringify({ hostKey }),
            });
            if (!claim.ok) throw new Error('claim');
            sessionStorage.setItem(hostKeyName(newID), hostKey);
            setRole(newID, 'tv'); // this tab is the big screen
            location.href = `/${newID}`;
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
  let joining = false;
  const doJoin = async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code || joining) return;
    joining = true;
    document.getElementById('err').textContent = '';
    try {
      const found = /^[A-Z]{4}$/.test(code) ? await roomGame(code) : null;
      if (found) {
        setRole(code, null); // joining as a player
        location.href = `/${code}`;
      } else {
        document.getElementById('err').textContent = 'No room with that code.';
      }
    } catch (e) {
      document.getElementById('err').textContent = 'Cannot reach the game server. Try again.';
    }
    joining = false;
  };
  // A form: pressing Enter in the code field is the same as clicking Join
  document.getElementById('joinform').onsubmit = (e) => {
    e.preventDefault();
    doJoin();
  };
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
      if (s.tv) {
        setRole(s.match, 'tv');
        if (s.hostKey) sessionStorage.setItem(hostKeyName(s.match), s.hostKey);
      } else {
        setRole(s.match, null);
        sessionStorage.setItem(`seat-${s.game}-${s.match}`, JSON.stringify(s.seat));
      }
      location.href = `/${s.match}`;
    };
  });
}

// ---- TV: lobby, then the game's public screen ----
async function tv() {
  const joinURL = `${location.origin}/${matchID}`;
  const qr = await QRCode.toDataURL(joinURL, { width: 280, margin: 2 });
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const client = connect();
    saveSession(`tv:${gameID}:${matchID}`, { game: gameID, match: matchID, tv: true, hostKey: getHostKey(matchID) });
  let frame = null;
  let lastState = null;
  client.start();
  watchSeats(client, () => lastState && render(lastState));
  client.subscribe((state) => {
    lastState = state;
    render(state);
  });
  function render(state) {
    if (!state) {
      if (!frame) app.innerHTML = '<div class="page"><p>Connecting…</p></div>';
      return;
    }
    if (!allJoined(client)) {
      frame = null; // not enough players (any more): back to the join screen
      app.innerHTML = `
        <div class="page">
          <h1>${esc(entry.name)}</h1>
          <p>Go to this site on your phone and enter the code, or scan:</p>
          <p class="code">${esc(matchID)}</p>
          <img class="qr" src="${qr}" alt="QR code to join" />
          <p>${esc(joinURL)}</p>
          ${isLocal ? '<p class="warn">Phones cannot reach "localhost". Open this page using the Network address instead.</p>' : ''}
          ${seatsHTML(client)}
          <p><a href="/" class="newgame">New game</a></p>
        </div>`;
      return;
    }
    if (!frame) {
      frame = buildShell(
        () => {},
        (entry.openJoin ? '<button id="joinbtn">➕ Join</button> ' : '') + '<a href="/" class="newgame">New game</a>'
      );
      if (entry.openJoin) addJoinPanel(joinURL, qr);
    }
    frame.send(stateMessage('public', null, client, state));
  }
}

// ---- Spectator: watches the public screen, takes no seat ----
function spectate() {
  const client = connect();
  let frame = null;
  let lastState = null;
  client.start();
  watchSeats(client, () => lastState && render(lastState));
  client.subscribe((state) => {
    lastState = state;
    render(state);
  });
  function render(state) {
    if (!state) return;
    if (!allJoined(client)) {
      frame = null; // everybody left: wait for players again
      app.innerHTML = `<div class="page"><h2>Waiting for players…</h2>${seatsHTML(client)}</div>`;
      return;
    }
    if (!frame) frame = buildShell(() => {}, 'Watching', undefined, true);
    frame.send(stateMessage('public', null, client, state));
  }
}

// ---- Phone: join form ----
const NICK_KEY = 'party-nickname';
const NICK_MAX = 16;
const ADJECTIVES = ['Stealthy', 'Sneaky', 'Bouncy', 'Fuzzy', 'Giddy', 'Zesty', 'Wobbly', 'Jolly', 'Cosmic', 'Sassy',
  'Dizzy', 'Mighty', 'Snazzy', 'Groovy', 'Plucky', 'Cheeky', 'Sleepy', 'Turbo', 'Funky', 'Wacky', 'Brave', 'Clever',
  'Dapper', 'Feisty', 'Gleeful', 'Jazzy', 'Lucky', 'Nifty', 'Peppy', 'Quirky', 'Rowdy', 'Speedy', 'Spunky', 'Sunny',
  'Zany', 'Epic', 'Mellow', 'Perky', 'Swanky', 'Fluffy'];
const ANIMALS = ['Wombat', 'Penguin', 'Otter', 'Llama', 'Badger', 'Narwhal', 'Koala', 'Panda', 'Gecko', 'Moose',
  'Walrus', 'Hedgehog', 'Platypus', 'Sloth', 'Falcon', 'Lobster', 'Ferret', 'Capybara', 'Flamingo', 'Raccoon',
  'Octopus', 'Dolphin', 'Alpaca', 'Beaver', 'Cobra', 'Meerkat', 'Puffin', 'Yak', 'Toucan', 'Lemur', 'Tiger', 'Zebra',
  'Gopher', 'Iguana', 'Mantis', 'Quokka', 'Pelican', 'Marmot', 'Goldfish', 'Hamster'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Three different fun nicknames like "Stealthy Wombat" (short enough for the nickname field)
function suggestNicknames(count = 3) {
  const out = new Set();
  for (let tries = 0; out.size < count && tries < 200; tries++) {
    const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
    if (name.length <= NICK_MAX) out.add(name);
  }
  return [...out];
}

function lastNickname() {
  try {
    return (localStorage.getItem(NICK_KEY) || '').slice(0, NICK_MAX);
  } catch (e) {
    return '';
  }
}

function rememberNickname(name) {
  try {
    localStorage.setItem(NICK_KEY, name);
  } catch (e) {
    /* storage can be blocked; the field is then simply empty next time */
  }
}

function joinForm(notice) {
  const ideas = suggestNicknames();
  app.innerHTML = `
    <div class="page">
      <h1>${esc(entry.name)}</h1>
      <p>Room ${esc(matchID)}</p>
      ${notice ? `<p class="warn">${esc(notice)}</p>` : ''}
      <input id="nick" placeholder="Your nickname" maxlength="${NICK_MAX}" autocomplete="off" spellcheck="false" enterkeyhint="go" />
      <br /><button id="go">Join as player</button>
      <button id="watch" class="secondary">Just watch</button>
      <div class="suggest">
        <p>Or pick one:</p>
        ${ideas.map((n) => `<button type="button" class="idea">${esc(n)}</button>`).join('')}
      </div>
      <p id="err" class="warn"></p>
      <p><a href="/">← Back to the games</a></p>
    </div>`;
  const nick = document.getElementById('nick');
  const go = document.getElementById('go');
  nick.value = lastNickname(); // the nickname used last time
  document.getElementById('watch').onclick = () => {
    setRole(matchID, 'watch');
    location.reload();
  };
  const join = async (chosen) => {
    if (go.disabled) return; // already joining
    const typed = (typeof chosen === 'string' ? chosen : nick.value).trim();
    const name = typed || 'Player';
    go.disabled = true;
    app.querySelectorAll('.idea').forEach((b) => (b.disabled = true));
    try {
      const { playerID, playerCredentials } = await api(gameID, `${matchID}/join`, {
        playerName: name,
      });
      const seat = { playerID, credentials: playerCredentials };
      if (typed) rememberNickname(typed);
      rememberSeat(seat, name);
      playPhone(seat);
    } catch (e) {
      go.disabled = false;
      app.querySelectorAll('.idea').forEach((b) => (b.disabled = false));
      document.getElementById('err').textContent =
        'Could not join. Check the code, or the room may be full. You can still watch.';
    }
  };
  go.onclick = () => join();
  // Tapping a suggestion picks that nickname and goes straight into the room
  app.querySelectorAll('.idea').forEach((b) => {
    b.onclick = () => {
      nick.value = b.textContent;
      join(b.textContent);
    };
  });
  nick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      join(); // the same as clicking the button
    }
  });
  nick.focus();
  nick.select(); // typing replaces the remembered nickname
}

function allJoined(client) {
  const seats = client.matchData || [];
  if (entry && entry.openJoin) {
    // Open games run with at least minJoined players (default 1). When too few are left,
    // the TV and phones fall back to the join / waiting screen.
    return seats.filter((p) => p.name).length >= (entry.minJoined || 1);
  }
  return seats.length > 0 && seats.every((p) => p.name);
}

// Does the server still hold this seat for us? (It frees seats whose phone stayed offline.)
// Only open-join games free seats. If the server cannot be reached, assume yes.
async function seatValid(seat) {
  if (!entry || !entry.openJoin) return true;
  try {
    const res = await fetch(`${SERVER}/seat/${matchID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ playerID: seat.playerID, credentials: seat.credentials }),
    });
    if (res.status === 403) return false;
    return true;
  } catch (e) {
    return true;
  }
}

async function phone() {
  // Same tab (for example a refresh): carry straight on
  const inTab = JSON.parse(
    sessionStorage.getItem(`seat-${gameID}-${matchID}`) || 'null'
  );
  if (inTab) {
    const exists = await roomExists(gameID, matchID);
    if (exists && (await seatValid(inTab))) return playPhone(inTab);
    sessionStorage.removeItem(`seat-${gameID}-${matchID}`);
    forgetSession(seatKey());
    return joinForm(
      exists ? SEAT_NOTICE : 'That room has ended. You can join again if the host starts a new one.'
    );
  }

  // A returning player on this device (the tab was closed): offer to continue
  const saved = loadSessions()[seatKey()];
  if (saved && saved.seat && (await roomExists(gameID, matchID)) && (await seatValid(saved.seat))) {
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
  joinForm(takeSeatNotice());
}

// ---- Phone: a seated player. Can flip between "my screen" and the TV view ----
function playPhone(seat) {
  currentSeat = seat;
  const player = connect({ playerID: seat.playerID, credentials: seat.credentials });
  const watcher = connect(); // a second, spectator connection for the TV view
  const latest = { player: null, watcher: null };
  let showing = 'player';
  let frame = null;

  function draw() {
    if (!latest.player) return;
    if (!allJoined(player)) {
      frame = null; // not enough players (any more): back to the waiting screen
      showing = 'player';
      const who = namesOf(player)[seat.playerID];
      app.innerHTML = `<div class="bar">${barLeft(who)}<span id="bar-extra">${menuButtonHTML()}</span></div>
        <div class="page"><h2>You're in!</h2><p>Waiting for other players…</p>${seatsHTML(player)}</div>`;
      phoneMenu.attach(null); // no game screen yet, so Leave goes straight home
      return;
    }
    if (!frame) {
      frame = buildShell(
        (name, args) => {
          if (showing !== 'player' && name !== 'leave') return; // "leave" must always get through
          const fn = player.moves[name];
          if (typeof fn === 'function') fn(...args);
        },
        '<button id="flip">📺 TV view</button>',
        namesOf(player)[seat.playerID],
        true
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
  // One poll refreshes both connections (so the TV view's names stay current), and tells
  // this phone if the server has given its seat away.
  watchSeats([player, watcher], draw, (players) => {
    const mine = players.find((p) => String(p.id) === String(seat.playerID));
    if (mine && !mine.name) seatLost();
  });
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

function noRoom() {
  app.innerHTML = `<div class="page"><h1>No room ${esc(matchID)}</h1>
    <p>That room doesn't exist, or it has ended.</p>
    <p><a href="/">Back to the games</a></p></div>`;
}

async function main() {
  try {
    const res = await fetch(`${SERVER}/catalog.json`);
    catalog = await res.json();
  } catch (e) {
    app.innerHTML = '<div class="page"><p>Cannot reach the game server.</p></div>';
    return;
  }

  // Old links looked like /?game=find-it&match=ABCD&view=tv. Send them to the new address.
  const old = (params.get('match') || '').toUpperCase();
  if (!matchID && /^[A-Z]{4}$/.test(old)) {
    const v = params.get('view');
    if (v === 'tv' || v === 'watch') setRole(old, v);
    location.replace(`/${old}`);
    return;
  }

  if (!matchID) return home();

  // The address has only the code, so ask the server which game it belongs to
  let found;
  try {
    found = await roomGame(matchID);
  } catch (e) {
    app.innerHTML = '<div class="page"><p>Cannot reach the game server.</p></div>';
    return;
  }
  if (!found) return noRoom();
  gameID = found;
  entry = catalog.find((g) => g.id === gameID) || null;
  if (!entry) return notFound();
  const role = getRole(matchID);
  if (role === 'tv') return tv();
  if (role === 'watch') return spectate();
  return phone();
}

main().catch((e) => {
  app.innerHTML = `<div class="page"><p>Something went wrong: ${esc(e.message)}</p></div>`;
});