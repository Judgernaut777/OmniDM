/* OmniDM table client — speaks the web adapter's JSON-frame protocol
 * (src/adapters/web.ts): hello/say up, welcome/roster/msg/error down.
 * Plain JS, no build step, no external origins.
 *
 * SECURITY: players and the LLM are both untrusted. Every piece of text from
 * the socket enters the DOM via textContent / createTextNode — never innerHTML.
 * renderRich() below is the only "markdown": it splits **bold** and `code`
 * into element nodes whose content is still set with textContent.
 *
 * Reconnect: join info is kept in `state.join`; on a dropped socket we retry
 * with exponential backoff (1s → 15s cap). The server mints a fresh userId per
 * connection, so after a reconnect a player re-claims their seat with
 * `/dm join <name>` — the client says so instead of pretending otherwise.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

const state = {
  ws: null,
  join: null,          // { userName, channelId, password? } — preserved across reconnects
  wantReconnect: false,
  welcomedOnce: false, // distinguishes first join from a reconnect
  welcomed: false,     // this connection completed the hello handshake
  backoff: 1000,       // ms, doubles to BACKOFF_MAX, resets on welcome
  userId: null,
  roster: [],          // [{ userId, userName }] — sockets in the room
  chars: new Map(),    // userName → characterName (parsed from relayed /dm join lines)
  turnName: null,      // round-robin: whose turn, parsed from DM notices
};
const BACKOFF_MAX = 15000;

/* ── Connection ──────────────────────────────────────────────────────────── */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  state.welcomed = false;
  ws.addEventListener('open', () => {
    setStatus('joining…');
    ws.send(JSON.stringify({ type: 'hello', ...state.join }));
  });
  ws.addEventListener('message', (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    onFrame(f);
  });
  ws.addEventListener('close', onClose);
}

function onClose() {
  if (!state.wantReconnect) return showJoin('');
  const wait = state.backoff;
  state.backoff = Math.min(state.backoff * 2, BACKOFF_MAX);
  setStatus(`reconnecting in ${Math.round(wait / 1000)}s…`);
  addLine('sys', '', `Connection lost — retrying in ${Math.round(wait / 1000)}s…`);
  setTimeout(() => { if (state.wantReconnect) connect(); }, wait);
}

function sendSay(text) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return addLine('err', '', 'Not connected — hold on while the table is rejoined.');
  }
  state.ws.send(JSON.stringify({ type: 'say', text }));
}

/* ── Frames ──────────────────────────────────────────────────────────────── */

function onFrame(f) {
  if (f.type === 'welcome') {
    state.welcomed = true;
    state.userId = f.userId;
    state.backoff = 1000;
    $('join-screen').hidden = true;
    $('table').hidden = false;
    $('room-label').textContent = String(f.channelId);
    setStatus('connected');
    const mine = state.chars.get(state.join.userName);
    addLine('sys', '', state.welcomedOnce
      ? `Reconnected.${mine ? ` Re-claim your seat with /dm join ${mine}.` : ''}`
      : 'You take a seat at the table. Start with /dm new, then /dm join <character name> — or open the ⚔ command menu.');
    state.welcomedOnce = true;
    $('say').focus();
  } else if (f.type === 'roster') {
    state.roster = Array.isArray(f.users) ? f.users : [];
    renderRoster();
  } else if (f.type === 'msg') {
    onChat(f);
  } else if (f.type === 'error') {
    // An error before welcome means the hello was refused (e.g. bad password):
    // fall back to the join screen instead of hammering the server with retries.
    if (!state.welcomed) {
      state.wantReconnect = false;
      showJoin(String(f.error ?? 'Join refused.'));
    } else {
      addLine('err', '', String(f.error ?? 'error'));
    }
  }
}

function onChat(f) {
  const speaker = typeof f.speaker === 'string' ? f.speaker : '';
  const text = typeof f.text === 'string' ? f.text : '';
  if (!speaker) parseNotice(text); // bot notices carry party/turn facts
  if (speaker && speaker !== 'Dungeon Master') parseRelay(speaker, text);
  let kind;
  if (f.private) kind = 'whisper';
  else if (speaker === 'Dungeon Master') kind = 'dm';
  else if (speaker) kind = speaker === state.join.userName ? 'player me' : 'player';
  else kind = 'sys';
  addLine(kind, speaker, text);
}

/* The adapter has no game-state frames, so the sidebar is fed heuristically:
 * relayed player lines reveal who plays whom, and the bot's own turn notices
 * ("Next up: X." / "It's X's turn") reveal the round-robin pointer. */
function parseRelay(speaker, text) {
  const join = /^\/dm\s+join\s+(.+)/.exec(text);
  if (join) state.chars.set(speaker, join[1].trim());
  else if (/^\/dm\s+new\b/.test(text)) state.chars.set(speaker, speaker);
  else return;
  renderRoster();
}

function parseNotice(text) {
  const m = /Next up: (.+?)\./.exec(text) || /It's (.+?)'s turn/.exec(text);
  if (m) state.turnName = m[1];
  if (text.includes('Immediate mode') || text.includes('Campaign ended')) state.turnName = null;
  if (text.includes('Campaign ended')) state.chars.clear();
  renderRoster();
}

/* ── Log ─────────────────────────────────────────────────────────────────── */

function addLine(kind, speaker, text) {
  const log = $('log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const art = el('article', `msg ${kind}`);
  if (kind === 'whisper') {
    const tag = el('span', 'mist-tag');
    tag.textContent = '🌫 only you hear this';
    art.append(tag);
  }
  if (speaker && kind !== 'sys' && kind !== 'err') {
    const who = el('div', 'speaker');
    who.textContent = speaker;
    if (kind.startsWith('player')) who.style.color = hueFor(speaker);
    art.append(who);
  }
  const body = el('div', 'body');
  renderRich(text, body);
  art.append(body);
  log.append(art);
  if (stick) log.scrollTop = log.scrollHeight;
}

/* Minimal XSS-safe rich text: only **bold** and `code`, every piece of content
 * lands in the DOM as a text node. Nothing else is interpreted. */
function renderRich(text, into) {
  for (const part of String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const b = el('strong'); b.textContent = part.slice(2, -2); into.append(b);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const c = el('code'); c.textContent = part.slice(1, -1); into.append(c);
    } else {
      into.append(document.createTextNode(part));
    }
  }
}

/* ── Roster sidebar ──────────────────────────────────────────────────────── */

function renderRoster() {
  const box = $('roster-list');
  box.replaceChildren();
  for (const u of state.roster) {
    const seat = el('div', 'seat');
    const dot = el('span', 'dot');
    dot.style.color = dot.style.background = hueFor(u.userName);
    const names = el('div', 'names');
    const user = el('div', 'user');
    user.textContent = u.userName + (u.userId === state.userId ? ' (you)' : '');
    names.append(user);
    const char = state.chars.get(u.userName);
    if (char && char !== u.userName) {
      const c = el('div', 'char');
      c.textContent = `as ${char}`;
      names.append(c);
    }
    seat.append(dot, names);
    const turn = state.turnName &&
      [char, u.userName].some((n) => n && n.toLowerCase() === state.turnName.toLowerCase());
    if (turn) {
      seat.classList.add('turn');
      const badge = el('span', 'turn-badge');
      badge.textContent = '⚔ acting';
      seat.append(badge);
    }
    box.append(seat);
  }
  $('turn-line').textContent = state.turnName ? `⚔ ${state.turnName} acts` : '';
}

/** Deterministic per-name hue, so a speaker keeps one color everywhere. */
function hueFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 45% 62%)`;
}

/* ── Join screen / status ────────────────────────────────────────────────── */

function setStatus(text) { $('status').textContent = text; }

function showJoin(error) {
  $('table').hidden = true;
  $('palette').hidden = true;
  $('join-screen').hidden = false;
  $('join-error').textContent = error;
  state.roster = [];
  state.turnName = null;
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const userName = $('j-name').value.trim();
  const channelId = $('j-room').value.trim();
  if (!userName || !channelId) return;
  const password = $('j-pass').value;
  state.join = { userName, channelId, ...(password ? { password } : {}) };
  try { localStorage.setItem('omnidm-join', JSON.stringify({ userName, channelId })); } catch { /* private mode */ }
  state.wantReconnect = true;
  state.backoff = 1000;
  $('join-error').textContent = '';
  setStatus('connecting…');
  connect();
});

try {
  const saved = JSON.parse(localStorage.getItem('omnidm-join') || 'null');
  if (saved?.userName) $('j-name').value = saved.userName;
  if (saved?.channelId) $('j-room').value = saved.channelId;
} catch { /* first visit */ }

$('leave-btn').addEventListener('click', () => {
  state.wantReconnect = false;
  state.ws?.close();
});

/* ── Composer, dice tray ─────────────────────────────────────────────────── */

$('say-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('say').value.trim();
  if (!text) return;
  sendSay(text);
  $('say').value = '';
});

for (const btn of document.querySelectorAll('#dice-tray [data-roll]')) {
  btn.addEventListener('click', () => sendSay(`/dm roll ${btn.dataset.roll}`));
}
$('roll-custom-btn').addEventListener('click', () => {
  const notation = $('roll-custom').value.trim();
  if (notation) sendSay(`/dm roll ${notation}`);
});
$('roll-custom').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('roll-custom-btn').click(); }
});

/* ── Command palette — /dm commands without remembering syntax ───────────── */

const COMMANDS = [
  { cmd: '/dm new', hint: 'Start a new campaign in this room', send: true },
  { cmd: '/dm join ', arg: '<character name>', hint: 'Join the party (or rename your character)' },
  { cmd: '/dm who', hint: 'Show the party and their HP', send: true },
  { cmd: '/dm roll ', arg: '<notation>', hint: 'Roll dice — d20+5, 2d6, d20 adv, 4d6kh3' },
  { cmd: '/dm mode round-robin', hint: 'Take turns in join order', send: true },
  { cmd: '/dm mode immediate', hint: 'Every message is a turn (default)', send: true },
  { cmd: '/dm turn', hint: 'Show whose turn it is (round-robin)', send: true },
  { cmd: '/dm pass', hint: 'Skip your turn (round-robin)', send: true },
  { cmd: '/dm fog on', hint: 'Fog of war — the DM may whisper secrets to one character', send: true },
  { cmd: '/dm fog off', hint: 'All narration is shared with the whole party', send: true },
  { cmd: '/dm import ', arg: '<file-or-URL>', hint: 'Import a Character Card V2/V3 (JSON or PNG)' },
  { cmd: '/dm lore add ', arg: '<name> | <keywords> | <content>', hint: 'Add world info, injected when a keyword comes up' },
  { cmd: '/dm lore list', hint: 'Show the lorebook', send: true },
  { cmd: '/dm lore remove ', arg: '<id-or-name>', hint: 'Remove a lore entry' },
  { cmd: '/dm models', hint: 'List usable models (🆓 = free)', send: true },
  { cmd: '/dm model ', arg: '<id>', hint: 'Pick the model for this game' },
  { cmd: '/dm help', hint: 'Show the full command reference', send: true },
  { cmd: '/dm end', hint: 'End the campaign (fills the box — press Send to confirm)', danger: true },
];

{
  const list = $('palette-list');
  for (const c of COMMANDS) {
    const btn = el('button', `cmd${c.danger ? ' danger' : ''}`);
    btn.type = 'button';
    const line = el('div', 'cmd-line');
    line.textContent = c.cmd;
    if (c.arg) { const a = el('span', 'cmd-arg'); a.textContent = c.arg; line.append(a); }
    const hint = el('div', 'cmd-hint');
    hint.textContent = c.hint;
    btn.append(line, hint);
    btn.addEventListener('click', () => {
      $('palette').hidden = true;
      if (c.send) return sendSay(c.cmd);
      $('say').value = c.cmd;
      $('say').focus();
    });
    list.append(btn);
  }
}

$('palette-btn').addEventListener('click', () => { $('palette').hidden = !$('palette').hidden; });
$('palette').addEventListener('click', (e) => { if (e.target === $('palette')) $('palette').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('palette').hidden = true; });
