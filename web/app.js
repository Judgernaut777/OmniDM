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
  transport: null,     // the active Transport (RemoteTransport | LocalTransport)
  mode: 'local',       // 'local' (in-app engine) | 'server' (WebSocket)
  settings: null,      // { mode, userName, channelId, server:{url,password}, llm:{…} } — persisted
  join: null,          // { userName, channelId, password? } — preserved across reconnects
  wantReconnect: false,
  retryTimer: null,    // pending reconnect timeout — cancelled by Leave
  welcomedOnce: false, // distinguishes first join from a reconnect
  welcomed: false,     // this connection completed the hello handshake
  backoff: 1000,       // ms, doubles to BACKOFF_MAX, resets on welcome
  userId: null,
  uploadToken: null,   // per-seat secret from welcome — authorizes MY portrait upload only
  roster: [],          // [{ userId, userName }] — sockets in the room
  chars: new Map(),    // userName → characterName (parsed from relayed /dm join lines)
  turnName: null,      // round-robin: whose turn, parsed from DM notices
  creatorPrompted: false, // auto-opened the creator once this connection (first-time setup)
  // creator: optimistic class pick (for an instant preview before the roster
  // confirms) + the name/bio a Save is awaiting server confirmation for — the
  // status text is only promoted to "Saved" once the enriched roster reflects it,
  // so a rejected `/dm join`/`/dm bio` (e.g. before `/dm new`) never shows a lie.
  creator: { pendingClass: null, pendingName: null, pendingBio: null },
  // lastRollSeen: the scene's rollSeq we last acted on. null until the first
  // scene frame, whose roll (if any) predates us and is adopted, never popped.
  scene: { tokens: [], actor: null, lastRoll: null, lastRollSeen: null }, // the shared token board
};
const BACKOFF_MAX = 15000;

/* ── Connection (transport-agnostic) ─────────────────────────────────────────
 * app.js never touches a WebSocket or the engine directly — it drives a
 * Transport (web/transport.js) that routes the SAME protocol frames either over
 * a WebSocket to a server (RemoteTransport) or through the in-page engine
 * (LocalTransport). Both call back into onFrame/onTransportOpen/onClose. */

function connect() {
  const T = globalThis.OmniDMTransport;
  state.welcomed = false;
  const cb = { onFrame, onOpen: onTransportOpen, onClose };
  if (!T) return showJoin('Client transport failed to load (web/transport.js).');
  if (state.mode === 'local') {
    // Test seams: the offline smoke injects a mock provider + storage so a full
    // turn runs with no network. In production both are undefined and the engine
    // builds a real provider from the user's settings + durable browser storage.
    const w = typeof window !== 'undefined' ? window : {};
    state.transport = new T.LocalTransport({
      settings: state.settings || {},
      provider: w.__omnidmTestProvider || undefined,
      storage: w.__omnidmTestStorage || undefined,
      ...cb,
    });
  } else {
    const serverUrl = (state.settings && state.settings.server && state.settings.server.url) || '';
    state.transport = new T.RemoteTransport({ serverUrl, ...cb });
  }
  state.transport.open();
}

/** The transport is ready to receive frames — send the hello handshake. */
function onTransportOpen() {
  setStatus('joining…');
  const hello = { type: 'hello', userName: state.join.userName, channelId: state.join.channelId };
  // A room password is a SERVER concept; the in-app engine is open (this device).
  if (state.mode === 'server' && state.join.password) hello.password = state.join.password;
  state.transport.send(hello);
}

function onClose() {
  // Only a server transport reconnects; the in-app engine has nothing to rejoin.
  if (!state.wantReconnect || !state.transport || !state.transport.supportsReconnect) {
    // A refused hello (or Leave) already showed the join screen — don't let
    // this trailing close event wipe the error message it is displaying.
    if ($('join-screen').hidden) showJoin('');
    return;
  }
  const wait = state.backoff;
  state.backoff = Math.min(state.backoff * 2, BACKOFF_MAX);
  setStatus(`reconnecting in ${Math.round(wait / 1000)}s…`);
  addLine('sys', '', `Connection lost — retrying in ${Math.round(wait / 1000)}s…`);
  state.retryTimer = setTimeout(() => { if (state.wantReconnect) connect(); }, wait);
}

function sendSay(text) {
  if (!state.transport || !state.transport.isOpen()) {
    return addLine('err', '', 'Not connected — hold on while the table is rejoined.');
  }
  state.transport.send({ type: 'say', text });
}

/* ── Frames ──────────────────────────────────────────────────────────────── */

function onFrame(f) {
  if (f.type === 'welcome') {
    state.welcomed = true;
    state.userId = f.userId;
    state.uploadToken = typeof f.uploadToken === 'string' ? f.uploadToken : null;
    state.backoff = 1000;
    $('join-screen').hidden = true;
    $('table').hidden = false;
    $('room-label').textContent = String(f.channelId);
    setStatus('connected');
    const mine = state.chars.get(state.join.userName);
    addLine('sys', '', state.welcomedOnce
      ? `Reconnected.${mine ? ` Re-claim your seat with /dm join ${mine}.` : ''}`
      : 'You take a seat at the table. Tap ⚔ Your character to create your hero, or start a campaign from the ⚔ command menu with /dm new.');
    state.welcomedOnce = true;
    $('say').focus();
  } else if (f.type === 'roster') {
    state.roster = Array.isArray(f.users) ? f.users : [];
    renderRoster();
  } else if (f.type === 'msg') {
    onChat(f);
  } else if (f.type === 'roll') {
    onRoll(f);
  } else if (f.type === 'scene') {
    onScene(f);
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

/* ── Dice ────────────────────────────────────────────────────────────────── */

/* A structured 'roll' frame (src/adapters/web.ts) rides alongside the DM
 * narration: the total is the engine's deterministic result, never re-rolled
 * here. Render each face as a tumbling die that settles on its value. Numbers
 * only from the socket, and notation/actor land via textContent — XSS-safe. */
function onRoll(f) {
  const notation = typeof f.notation === 'string' ? f.notation : '';
  const actor = typeof f.actor === 'string' ? f.actor : '';
  const note = typeof f.note === 'string' ? f.note : '';
  const dice = Array.isArray(f.dice) ? f.dice.filter((n) => Number.isFinite(n)) : [];
  const total = Number.isFinite(f.total) ? f.total : dice.reduce((s, n) => s + n, 0);
  const modifier = Number.isFinite(f.modifier) ? f.modifier : total - dice.reduce((s, n) => s + n, 0);

  const log = $('log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const art = el('article', 'msg roll');
  if (/nat 20|critical/i.test(note)) art.classList.add('crit');
  else if (/nat 1|fumble/i.test(note)) art.classList.add('fumble');

  const head = el('div', 'roll-head');
  head.textContent = `🎲 ${actor ? `${actor} rolls ` : 'Roll '}${notation}`;
  art.append(head);

  const tray = el('div', 'roll-dice');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const face of dice.length ? dice : [total]) {
    const die = el('span', 'die-face');
    die.textContent = String(face);
    if (!reduce) {
      die.style.animationDelay = `${Math.floor(Math.random() * 140)}ms`;
      settleDie(die, face);
    }
    tray.append(die);
  }
  art.append(tray);

  const sum = el('div', 'roll-total');
  if (modifier) {
    const mod = el('span', 'roll-mod');
    mod.textContent = modifier > 0 ? `+${modifier}` : String(modifier);
    tray.append(mod);
  }
  sum.append(document.createTextNode('= '));
  const strong = el('strong');
  strong.textContent = String(total);
  sum.append(strong);
  if (note) { const n = el('span', 'roll-note'); n.textContent = note; sum.append(n); }
  art.append(sum);

  log.append(art);
  if (stick) log.scrollTop = log.scrollHeight;
}

/* Make a die visibly tumble through random faces before settling on the
 * engine's real value (never re-rolled — the final face is always `value`).
 * Off under prefers-reduced-motion (the caller skips this entirely) and
 * non-blocking: it drives itself on a short timer and lands quickly. */
function settleDie(die, value) {
  let ticks = 5 + Math.floor(Math.random() * 5);
  const hi = Math.max(6, value);
  const iv = setInterval(() => {
    if (ticks-- <= 0) {
      clearInterval(iv);
      die.textContent = String(value); // authoritative: settle on the real face
      die.classList.remove('spin');
      die.classList.add('settled');
      return;
    }
    die.textContent = String(1 + Math.floor(Math.random() * hi));
    die.classList.toggle('spin');
  }, 72);
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
    seat.setAttribute('role', 'button');
    seat.tabIndex = 0;
    seat.title = 'Open character card';
    const frame = el('span', 'seat-portrait');
    frame.append(makePortrait(u));
    const names = el('div', 'names');
    const user = el('div', 'user');
    user.textContent = u.userName + (u.userId === state.userId ? ' (you)' : '');
    names.append(user);
    // The enriched roster carries the server's character name; fall back to the
    // heuristic map parsed from relayed /dm join lines when it is absent.
    const char = charName(u);
    if (char && char !== u.userName) {
      const c = el('div', 'char');
      c.textContent = `as ${char}`;
      names.append(c);
    }
    seat.append(frame, names);
    const turn = state.turnName &&
      [char, u.userName].some((n) => n && n.toLowerCase() === state.turnName.toLowerCase());
    if (turn) {
      seat.classList.add('turn');
      const badge = el('span', 'turn-badge');
      badge.textContent = '⚔ acting';
      seat.append(badge);
    }
    seat.addEventListener('click', () => openCard(u));
    seat.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(u); }
    });
    box.append(seat);
  }
  $('turn-line').textContent = state.turnName ? `⚔ ${state.turnName} acts` : '';
  // Keep the live creator preview in step with server state, confirm any pending
  // name/bio Save the roster now reflects, and offer the first-time setup prompt
  // once my own seat has arrived.
  if (!$('creator').hidden) { updateCreator(); reconcileCreatorStatus(); }
  maybePromptCreator();
}

/** A seat's character name: server-enriched roster first, then the relay map. */
function charName(u) {
  return (typeof u.characterName === 'string' && u.characterName) || state.chars.get(u.userName) || '';
}

/* A round token for a roster seat / card sheet: an uploaded image (same-origin)
 * when the descriptor is {kind:'image', url}, with the procedural crest as its
 * onerror fallback; a preset crest for {kind:'preset', id}; otherwise a crest
 * seeded on the character/user name. portraitSVG (portraits.js) builds every
 * crest with createElementNS — never innerHTML. */
/* Resolve a roster/board portrait descriptor URL for DISPLAY. The descriptor
 * carries a SERVER-RELATIVE "/portrait/<ch>/<uid>" path (defaultPortraitUrl on
 * the server). When the active transport talks to a server on a DIFFERENT origin
 * (cross-origin RemoteTransport — the hosted-client / Tauri / Capacitor story),
 * that path must resolve against the SERVER's HTTP base, not the page origin, or
 * every portrait <img>/<image> 404s and falls back to a crest. Same-origin ('')
 * and absolute (http(s):, data:) URLs pass through unchanged. Mirrors the upload
 * path, which already prefixes httpBase(). */
function portraitUrl(url) {
  if (typeof url !== 'string') return url;
  const base = state.transport && state.transport.httpBase ? state.transport.httpBase() : '';
  return base && url.startsWith('/') ? base + url : url;
}

function makePortrait(u) {
  const seed = charName(u) || u.userName || '';
  const p = u && u.portrait;
  if (p && p.kind === 'image' && typeof p.url === 'string') {
    const img = document.createElement('img');
    img.src = portraitUrl(p.url);
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => img.replaceWith(portraitSVG(seed, {})));
    return img;
  }
  if (p && p.kind === 'preset' && typeof p.id === 'string') return portraitSVG(seed, { preset: p.id });
  return portraitSVG(seed, {});
}

/** Deterministic per-name hue, so a speaker keeps one color everywhere. */
function hueFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 45% 62%)`;
}

/* ── Character sheet (read-only) + creator (editable) ─────────────────────────
 * Two coherent surfaces share the roster's portrait descriptors:
 *  • Clicking ANOTHER player's seat opens the READ-ONLY card sheet — their
 *    portrait, name and bounded card/bio summary (all via textContent, since
 *    the card text is untrusted).
 *  • Clicking YOUR OWN seat, the topbar "⚔ Your character" button, or joining a
 *    room without a character yet, opens the CREATOR: set a name (/dm join),
 *    pick a class from a visual gallery of the 12 D&D 5e classes (/dm class),
 *    write a short bio (/dm bio), upload a portrait (POST /portrait) or import a
 *    Character Card (/dm import). A big live preview reflects the choices.
 * The whole flow is discoverable without knowing a single slash command. */

/* Class metadata — mirrors src/core/portraits.ts (the 12 D&D 5e classes) so the
 * gallery can show each class's name + flavor beside its procedural bust. */
const CLASS_INFO = [
  { id: 'barbarian', name: 'Barbarian', flavor: 'A raging warrior of primal fury.' },
  { id: 'bard', name: 'Bard', flavor: 'A silver-tongued weaver of song and magic.' },
  { id: 'cleric', name: 'Cleric', flavor: "A divine channeler of a god's power." },
  { id: 'druid', name: 'Druid', flavor: 'A shapeshifting guardian of the wild.' },
  { id: 'fighter', name: 'Fighter', flavor: 'A master of martial weapons and tactics.' },
  { id: 'monk', name: 'Monk', flavor: 'A disciplined martial artist channeling inner ki.' },
  { id: 'paladin', name: 'Paladin', flavor: 'A holy warrior bound by a sacred oath.' },
  { id: 'ranger', name: 'Ranger', flavor: 'A wilderness hunter and unerring tracker.' },
  { id: 'rogue', name: 'Rogue', flavor: 'A stealthy expert in guile and precision strikes.' },
  { id: 'sorcerer', name: 'Sorcerer', flavor: 'An innate wielder of raw arcane power.' },
  { id: 'warlock', name: 'Warlock', flavor: 'A caster empowered by an otherworldly pact.' },
  { id: 'wizard', name: 'Wizard', flavor: 'A robed scholar of the arcane.' },
];
const CLASS_BY_ID = new Map(CLASS_INFO.map((c) => [c.id, c]));

/* ── Read-only card sheet (other players) ─────────────────────────────────── */

function openCard(u) {
  if (!u) return;
  if (u.userId === state.userId) return openCreator(); // your own seat → editable creator
  $('card-portrait').replaceChildren(makePortrait(u));
  const name = charName(u) || u.userName || 'Adventurer';
  $('card-name').textContent = name;
  // Class + bio come off the enriched roster seat. All via textContent — the
  // values are untrusted, so they are never interpolated into markup.
  const cls = u && typeof u.class === 'string' ? u.class.trim() : '';
  const played = name !== u.userName ? `played by ${u.userName}` : u.userName;
  $('card-sub').textContent = cls ? `${cls} — ${played}` : played;
  const bio = u && typeof u.bio === 'string' ? u.bio.trim() : '';
  const desc = u && u.card && typeof u.card.description === 'string' ? u.card.description.trim() : '';
  $('card-desc').textContent = desc || bio || 'No character card imported yet.';
  $('card-sheet').hidden = false;
}

function closeCard() { $('card-sheet').hidden = true; }

$('card-close').addEventListener('click', closeCard);
$('card-sheet').addEventListener('click', (e) => { if (e.target === $('card-sheet')) closeCard(); });

/* ── Character creator (your own seat) ────────────────────────────────────── */

/** My own enriched roster seat, if the roster has arrived. */
function mySeat() { return state.roster.find((u) => u && u.userId === state.userId); }
/** My character name from the SERVER-enriched roster (not the relay heuristic). */
function myCharacterName() { const u = mySeat(); return (u && typeof u.characterName === 'string' && u.characterName.trim()) || ''; }
/** True once I've actually done `/dm join <name>` (a server-confirmed character). */
function characterIsSet() { return myCharacterName() !== ''; }

/** The class id currently in effect for me: my optimistic pick, else the server's.
 * The optimistic pick wins so the highlighted tile, class name and flavor track
 * the live portrait preview (creatorPreviewSeat also prefers pendingClass) the
 * instant a tile is clicked — instead of lagging a class change by a roster
 * round-trip because the server value was still the stale previous class. */
function currentClassId() {
  const u = mySeat();
  const raw = state.creator.pendingClass || (u && typeof u.class === 'string' && u.class) || '';
  return raw ? raw.trim().toLowerCase() : '';
}

/* The bot's `/dm` tokenizer collapses runs of whitespace, and the server clamps
 * a name to 40 / a bio to 500 chars — so normalize the same way before comparing
 * a pending Save against the value the roster echoes back, or a match is missed. */
const normSaved = (s, max) => String(s).trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Promote a pending name/bio Save to "Saved" ONLY once the server-enriched roster
 * actually reflects it — the client has no request/response correlation, so this
 * is how a Save waits for the server instead of optimistically claiming success.
 * A rejected command (e.g. `/dm join` before any `/dm new`) never lands in the
 * roster, so the status stays on "Saving…" while the log shows the real error —
 * no false confirmation. Called on every roster frame while the creator is open.
 */
function reconcileCreatorStatus() {
  const cr = state.creator;
  if (cr.pendingName != null) {
    const server = myCharacterName();
    if (server && normSaved(server, 40) === normSaved(cr.pendingName, 40)) {
      $('creator-name-status').textContent = `Saved. The party knows you as “${server}”.`;
      cr.pendingName = null;
    }
  }
  if (cr.pendingBio != null) {
    const u = mySeat();
    const server = u && typeof u.bio === 'string' ? u.bio : '';
    if (server && normSaved(server, 500) === normSaved(cr.pendingBio, 500)) {
      $('creator-bio-status').textContent = 'Bio saved.';
      cr.pendingBio = null;
    }
  }
}

/**
 * A seat-like object for the live preview: my roster seat, with an optimistic
 * class selection standing in for its portrait so a pick previews instantly —
 * but never over an uploaded/card IMAGE, which always wins (mirrors the server).
 */
function creatorPreviewSeat() {
  const u = mySeat();
  const seat = u ? Object.assign({}, u) : { userId: state.userId, userName: (state.join && state.join.userName) || '' };
  const hasImage = seat.portrait && seat.portrait.kind === 'image';
  if (state.creator.pendingClass && !hasImage) seat.portrait = { kind: 'preset', id: state.creator.pendingClass };
  return seat;
}

let creatorGalleryBuilt = false;
function buildCreatorGallery() {
  if (creatorGalleryBuilt) return;
  creatorGalleryBuilt = true;
  const g = $('card-gallery');
  const seed = myCharacterName() || (state.join && state.join.userName) || 'Adventurer';
  for (const info of CLASS_INFO) {
    const btn = el('button', 'crest-choice class-choice');
    btn.type = 'button';
    btn.dataset.cls = info.id;
    btn.title = info.flavor;
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-pressed', 'false');
    btn.append(portraitSVG(seed, { class: info.id }));
    const cap = el('span', 'crest-cap');
    cap.textContent = info.name;
    btn.append(cap);
    btn.addEventListener('click', () => {
      state.creator.pendingClass = info.id;
      sendSay(`/dm class ${info.id}`);
      updateCreator();
    });
    g.append(btn);
  }
}

/** Refresh the parts of the creator that reflect server/optimistic state — the
 * live portrait, the selected-class highlight, and the class name/flavor. Never
 * touches the name/bio inputs, so a background roster update can't clobber typing. */
function updateCreator() {
  $('creator-portrait').replaceChildren(makePortrait(creatorPreviewSeat()));
  const cls = currentClassId();
  for (const btn of $('card-gallery').querySelectorAll('.crest-choice')) {
    const on = btn.dataset.cls === cls;
    btn.classList.toggle('selected', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const info = cls ? CLASS_BY_ID.get(cls) : null;
  $('creator-classname').textContent = info ? info.name : 'No class chosen yet';
  $('creator-flavor').textContent = info ? info.flavor : 'Pick a class below to theme your portrait.';
}

function updateBioCount() {
  const n = $('creator-bio').value.length;
  $('creator-bio-count').textContent = `${n} / 500`;
}

function openCreator() {
  closeCard();
  buildCreatorGallery();
  const u = mySeat();
  state.creator.pendingClass = null;
  state.creator.pendingName = null;
  state.creator.pendingBio = null;
  $('creator-name').value = myCharacterName();
  $('creator-bio').value = (u && typeof u.bio === 'string') ? u.bio : '';
  updateBioCount();
  $('creator-name-status').textContent = '';
  $('creator-bio-status').textContent = '';
  $('creator-import').value = '';
  $('creator-import-status').textContent = '';
  $('card-upload-status').textContent = '';
  updateCreator();
  $('creator').hidden = false;
  $('creator-name').focus();
}

function closeCreator() { $('creator').hidden = true; }

/** After joining, if I have no character yet, open the creator once — the
 * first-time, no-slash-command path to setting up. */
function maybePromptCreator() {
  if (!state.welcomed || state.creatorPrompted) return;
  if (!mySeat()) return; // wait until my own seat is in the roster
  state.creatorPrompted = true;
  if (!characterIsSet()) openCreator();
}

$('creator-btn')?.addEventListener('click', openCreator);
$('creator-close')?.addEventListener('click', closeCreator);
$('creator')?.addEventListener('click', (e) => { if (e.target === $('creator')) closeCreator(); });

$('creator-name-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('creator-name').value.trim();
  if (!name) return;
  sendSay(`/dm join ${name}`); // also renames if already joined
  // Don't claim success yet — the join is rejected before `/dm new` exists.
  // reconcileCreatorStatus() promotes this to "Saved" once the roster confirms.
  state.creator.pendingName = name;
  $('creator-name-status').textContent = 'Saving…';
});

$('creator-bio')?.addEventListener('input', updateBioCount);
$('creator-bio-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('creator-bio').value.trim();
  if (!text) return;
  sendSay(`/dm bio ${text}`);
  // Same as the name Save: wait for the enriched roster to echo the bio back
  // before confirming, so a rejected `/dm bio` never shows a false "saved".
  state.creator.pendingBio = text;
  $('creator-bio-status').textContent = 'Saving…';
});

$('creator-import-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const src = $('creator-import').value.trim();
  if (!src) return;
  sendSay(`/dm import ${src}`);
  $('creator-import-status').textContent = 'Importing… watch the log for the result.';
});

/* Upload your own portrait image → POST /portrait (bytes go over HTTP, never a
 * WS frame). The per-seat upload token — not the room password — authorizes
 * writing MY OWN portrait. An uploaded image overrides the class portrait. */
$('card-file')?.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // let the same file be re-picked after a failure
  if (!file || !state.join || !state.userId) return;
  const status = $('card-upload-status');
  status.textContent = 'Uploading…';
  try {
    let res;
    if (state.transport && state.transport.local) {
      // In-app: no HTTP endpoint — the engine stores the bytes in-process and
      // rebroadcasts the roster (which re-renders the live preview).
      res = await state.transport.uploadPortrait({ channelId: state.join.channelId, userId: state.userId, file });
    } else {
      if (!state.uploadToken) { status.textContent = 'Reconnecting — try again in a moment.'; return; }
      const ch = encodeURIComponent(state.join.channelId);
      const uid = encodeURIComponent(state.userId);
      const base = state.transport && state.transport.httpBase ? state.transport.httpBase() : '';
      // The seat token (from welcome) authorizes writing MY OWN portrait — the room
      // password gates joining, not whose portrait you set. Sent as a header so it
      // stays out of URLs/referrers.
      const r = await fetch(`${base}/portrait/${ch}/${uid}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upload-token': state.uploadToken },
        body: file,
      });
      res = { ok: r.ok, status: r.status };
    }
    if (!res.ok) {
      status.textContent = res.status === 401
        ? 'Upload refused — you can only set your own portrait.'
        : res.status === 409 ? 'Join the party first (save a name above) to set a portrait.'
        : res.status === 413 ? 'That image is too large.'
        : res.status === 415 ? 'That file type is not allowed (use PNG, JPEG, GIF or WebP).'
        : `Upload failed (${res.status}).`;
      return;
    }
    // The server/engine broadcasts a fresh roster, which re-renders the live preview.
    status.textContent = 'Portrait updated.';
  } catch {
    status.textContent = 'Upload failed — connection error.';
  }
});

/* ── Token board (VTT-lite) ──────────────────────────────────────────────────
 * The adapter owns the board: a 'scene' frame carries every token
 * { id, who, kind, x, y } with x,y normalized 0..1, the round-robin `actor`,
 * and the most recent `lastRoll`. Each token is drawn as its character's
 * PORTRAIT — the same uploaded image or procedural crest as the roster, reused
 * via the roster's portrait descriptor + portraitSVG — with a name label; PCs
 * and NPCs get distinct rings and the acting token glows with the candle motif.
 *
 * Shared table: anyone may drag ANY token (there is no per-owner lock). A drag
 * sends a throttled { type:'move', id, x, y } and a final frame on drop; the
 * server clamps to 0..1 and rebroadcasts the authoritative scene, so what we
 * render always comes back from the server. Every node is built with
 * createElementNS and every label lands via textContent — XSS-safe. */
const SVGNS = 'http://www.w3.org/2000/svg';
const TOKEN_R = 8; // token radius in the 0..100 board viewBox
// Keep a whole token — plus its label below — inside the 0..100 board.
const clampView = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01n = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
};

let drag = null;         // { id } while a token is being dragged
let lastMoveSent = 0;    // throttle stamp for outbound 'move' frames

function onScene(f) {
  state.scene.tokens = Array.isArray(f.tokens) ? f.tokens : [];
  state.scene.actor = typeof f.actor === 'string' ? f.actor : null;
  const roll = f.lastRoll && typeof f.lastRoll === 'object' ? f.lastRoll : null;
  state.scene.lastRoll = roll;
  renderBoard();
  // Pop the freshest roll near the roller's token — but only ONCE per new roll.
  // The server bumps `rollSeq` on every genuinely-new roll (even two identical
  // d20=15s), and the scene rebroadcasts unchanged on every move. So we pop only
  // when the sequence ADVANCES past what we've seen. The very first scene frame
  // just sets the baseline: whatever roll it carries happened before we joined
  // (or reconnected), so it must never pop a phantom die at us.
  const seq = Number.isFinite(f.rollSeq) ? f.rollSeq : 0;
  if (state.scene.lastRollSeen === null) {
    state.scene.lastRollSeen = seq;
  } else if (seq > state.scene.lastRollSeen) {
    state.scene.lastRollSeen = seq;
    if (roll) showRollPop(roll);
  }
}

/** A roster seat by userId — the source of a pc token's portrait descriptor. */
function rosterById(userId) {
  return state.roster.find((u) => u && u.userId === userId);
}

/* The portrait a token should wear: a pc token borrows its seat's descriptor
 * (uploaded image or preset crest) from the enriched roster; an npc token (and
 * any seat whose roster we haven't seen yet) falls back to a crest seeded on
 * its name. Mirrors makePortrait, but resolves to a descriptor the board can
 * turn into SVG nodes. */
function portraitForToken(t, kind) {
  if (kind === 'pc' && typeof t.id === 'string' && t.id.startsWith('pc:')) {
    const u = rosterById(t.id.slice(3));
    if (u) {
      const seed = charName(u) || u.userName || t.who || '';
      const p = u.portrait;
      if (p && p.kind === 'image' && typeof p.url === 'string') return { kind: 'image', url: p.url, seed };
      if (p && p.kind === 'preset' && typeof p.id === 'string') return { kind: 'preset', preset: p.id, seed };
      return { seed };
    }
  }
  return { seed: typeof t.who === 'string' ? t.who : '' };
}

/** A procedural crest as a nested <svg>, sized to fill a token circle. */
function crestNode(seed, preset) {
  const svg = portraitSVG(seed, preset ? { preset } : {});
  svg.setAttribute('x', String(-TOKEN_R));
  svg.setAttribute('y', String(-TOKEN_R));
  svg.setAttribute('width', String(TOKEN_R * 2));
  svg.setAttribute('height', String(TOKEN_R * 2));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  return svg;
}

/* The portrait node for one token: a same-origin <image> (with a procedural
 * crest as its onerror fallback), else the deterministic crest. */
function tokenPortrait(t, kind) {
  const desc = portraitForToken(t, kind);
  if (desc.kind === 'image' && typeof desc.url === 'string') {
    const img = svgEl('image', {
      x: -TOKEN_R, y: -TOKEN_R, width: TOKEN_R * 2, height: TOKEN_R * 2,
      preserveAspectRatio: 'xMidYMid slice',
    });
    img.setAttribute('href', portraitUrl(desc.url)); // /portrait/... resolved against the server origin (cross-origin transport) — never an arbitrary external host
    img.addEventListener('error', () => img.replaceWith(crestNode(desc.seed, '')));
    return img;
  }
  return crestNode(desc.seed, desc.preset);
}

function renderBoard() {
  const svg = $('board-svg');
  if (!svg) return;
  svg.replaceChildren();
  // One shared circular clip — evaluated in each translated token's own space,
  // so a circle at the origin clips the portrait to that token's disc.
  const defs = svgEl('defs', {});
  const clip = svgEl('clipPath', { id: 'tok-clip' });
  clip.append(svgEl('circle', { r: TOKEN_R }));
  defs.append(clip);
  svg.append(defs);
  for (const t of state.scene.tokens) {
    if (!t || typeof t.id !== 'string') continue;
    const x = Number.isFinite(t.x) ? clamp01n(t.x) : 0.5;
    const y = Number.isFinite(t.y) ? clamp01n(t.y) : 0.5;
    const who = typeof t.who === 'string' ? t.who : '';
    const kind = t.kind === 'npc' ? 'npc' : 'pc';
    const isActor = Boolean(state.scene.actor && who && state.scene.actor.toLowerCase() === who.toLowerCase());
    // Positions stay normalized (server-authoritative); only the DISPLAY is inset
    // so a token near an edge — and its label below — never clips the board.
    const cx = clampView(x * 100, TOKEN_R + 1, 100 - TOKEN_R - 1);
    const cy = clampView(y * 100, TOKEN_R + 1, 100 - TOKEN_R - 10);
    const g = svgEl('g', {
      class: `token ${kind}${isActor ? ' actor' : ''}`,
      transform: `translate(${cx.toFixed(2)} ${cy.toFixed(2)})`,
    });
    g.append(svgEl('circle', { r: TOKEN_R, class: 'token-disc' })); // opaque backing behind the crest
    const clipped = svgEl('g', { 'clip-path': 'url(#tok-clip)' });
    clipped.append(tokenPortrait(t, kind));
    g.append(clipped);
    g.append(svgEl('circle', { r: TOKEN_R, class: 'token-ring', fill: 'none' }));
    const label = svgEl('text', { y: TOKEN_R + 6, 'text-anchor': 'middle', class: 'token-label' });
    // Just the first name keeps adjacent tokens' labels from colliding.
    label.textContent = (who.split(' ')[0] || who).slice(0, 12);
    g.append(label);
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drag = { id: t.id };
      svg.setPointerCapture?.(e.pointerId);
    });
    svg.append(g);
  }
}

/* A dice result pops over the roller's token and fades, complementing the
 * felt-tray roller in the log. It lives in the board container (not the SVG
 * that re-renders on every move), so a concurrent drag can't tear it, and it
 * self-removes on animation end / a timer (the reduced-motion path). */
function showRollPop(roll) {
  const board = $('board');
  if (!board) return;
  const name = String(roll.actor || state.scene.actor || '').toLowerCase();
  const tok = state.scene.tokens.find((t) => t && typeof t.who === 'string' && name && t.who.toLowerCase() === name);
  const x = tok && Number.isFinite(tok.x) ? clamp01n(tok.x) : 0.5;
  const y = tok && Number.isFinite(tok.y) ? clamp01n(tok.y) : 0.5;
  const pop = el('div', 'board-pop');
  if (/nat 20|critical/i.test(roll.note || '')) pop.classList.add('crit');
  else if (/nat 1|fumble/i.test(roll.note || '')) pop.classList.add('fumble');
  pop.textContent = `🎲 ${Number.isFinite(roll.total) ? roll.total : ''}`;
  pop.style.left = `${(x * 100).toFixed(1)}%`;
  pop.style.top = `${(y * 100).toFixed(1)}%`;
  board.append(pop);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  pop.addEventListener('animationend', () => pop.remove());
  setTimeout(() => pop.remove(), reduce ? 1500 : 2600); // reduced-motion path + safety net
}

function boardNorm(evt) {
  const r = $('board-svg').getBoundingClientRect();
  return {
    x: clamp01n(r.width ? (evt.clientX - r.left) / r.width : 0.5),
    y: clamp01n(r.height ? (evt.clientY - r.top) / r.height : 0.5),
  };
}

function sendMove(id, x, y) {
  if (!state.transport || !state.transport.isOpen()) return;
  state.transport.send({ type: 'move', id, x, y });
}

{
  const svg = $('board-svg');
  if (svg) {
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const now = Date.now();
      if (now - lastMoveSent < 45) return; // throttle: stay well under the server's move allowance
      lastMoveSent = now;
      const { x, y } = boardNorm(e);
      sendMove(drag.id, x, y);
    });
    const end = (e) => {
      if (!drag) return;
      const { x, y } = boardNorm(e); // always send the final resting position on drop
      sendMove(drag.id, x, y);
      drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }
  // "Map" toggle — collapse the board without disturbing the chat/roster/composer.
  $('board-toggle')?.addEventListener('click', () => {
    const board = $('board');
    const btn = $('board-toggle');
    const hide = !board.hidden;
    board.hidden = hide;
    btn.textContent = hide ? 'Show map' : 'Hide map';
    btn.setAttribute('aria-expanded', String(!hide));
  });
}

/* ── Join screen / status ────────────────────────────────────────────────── */

function setStatus(text) { $('status').textContent = text; }

function showJoin(error) {
  $('table').hidden = true;
  $('palette').hidden = true;
  $('creator').hidden = true;
  $('card-sheet').hidden = true;
  state.creatorPrompted = false;
  state.creator.pendingClass = null;
  state.creator.pendingName = null;
  state.creator.pendingBio = null;
  $('join-screen').hidden = false;
  $('join-error').textContent = error;
  state.roster = [];
  state.turnName = null;
  state.scene = { tokens: [], actor: null, lastRoll: null, lastRollSeen: null };
  $('board-svg')?.replaceChildren();
  $('board')?.querySelectorAll('.board-pop').forEach((p) => p.remove());
}

/* ── Launch / settings ────────────────────────────────────────────────────────
 * The launch screen picks the transport: "Play on this device" (LocalTransport,
 * the in-app engine — bring your own model) vs "Connect to a server"
 * (RemoteTransport, WebSocket → multiplayer). The choice + fields are persisted
 * in localStorage under 'omnidm-settings'. The LLM API key lives ONLY there
 * (this device) and is passed ONLY to the engine → provider; it is never logged,
 * rendered, or written into a session. */

const SETTINGS_KEY = 'omnidm-settings';
const DEFAULT_LLM = { provider: '', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'meta-llama/llama-3.3-70b-instruct:free' };

/** Reflect the chosen mode in the launch UI (which fieldset shows, radios). */
function applyLaunchMode(mode) {
  state.mode = mode === 'server' ? 'server' : 'local';
  const local = state.mode === 'local';
  $('local-settings').hidden = !local;
  $('server-settings').hidden = local;
  for (const btn of document.querySelectorAll('.mode-choice')) {
    const on = btn.dataset.mode === state.mode;
    btn.classList.toggle('selected', on);
    btn.setAttribute('aria-checked', String(on));
  }
  $('launch-btn').textContent = local ? 'Play on this device' : 'Connect to the server';
}

/** Read the current launch settings out of the form. */
function readSettings() {
  return {
    mode: state.mode,
    userName: $('j-name').value.trim(),
    channelId: $('j-room').value.trim(),
    server: { url: $('j-server').value.trim(), password: $('j-pass').value },
    llm: {
      provider: $('llm-provider').value,
      baseUrl: $('llm-baseurl').value.trim(),
      apiKey: $('llm-apikey').value, // secret — stored locally only
      model: $('llm-model').value.trim(),
    },
  };
}

/** Persist settings (incl. the key) to this device only. Never logged. */
function persistSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode — settings just won't persist */ }
}

/** Prefill the launch form from persisted settings (or sensible defaults). */
function prefillSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { s = null; }
  if (!s) {
    // Migrate the older name/room-only record, if present.
    try { const old = JSON.parse(localStorage.getItem('omnidm-join') || 'null'); if (old) s = { userName: old.userName, channelId: old.channelId }; } catch { /* ignore */ }
  }
  s = s || {};
  const llm = Object.assign({}, DEFAULT_LLM, s.llm || {});
  if (s.userName) $('j-name').value = s.userName;
  if (s.channelId) $('j-room').value = s.channelId;
  $('llm-provider').value = llm.provider || '';
  $('llm-baseurl').value = llm.baseUrl || '';
  $('llm-apikey').value = llm.apiKey || '';
  $('llm-model').value = llm.model || '';
  if (s.server && s.server.url) $('j-server').value = s.server.url;
  applyLaunchMode(s.mode || 'local');
}

/** Topbar badge + creator note describing how this table runs. */
function updateModeBadge() {
  const badge = $('mode-badge');
  if (!badge) return;
  if (state.mode === 'local') { badge.textContent = '🕯 On this device'; badge.title = 'The AI DM runs in this app — solo / hotseat, this device only.'; }
  else { badge.textContent = '🌐 Server'; badge.title = 'Connected to an OmniDM server — multiplayer.'; }
}

for (const btn of document.querySelectorAll('.mode-choice')) {
  btn.addEventListener('click', () => applyLaunchMode(btn.dataset.mode));
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const userName = $('j-name').value.trim();
  const channelId = $('j-room').value.trim();
  if (!userName || !channelId) return;
  const settings = readSettings();
  state.settings = settings;
  const password = state.mode === 'server' ? settings.server.password : '';
  state.join = { userName, channelId, ...(password ? { password } : {}) };
  persistSettings(settings);
  // Only a server game reconnects; the in-app engine has nothing to reconnect to.
  state.wantReconnect = state.mode === 'server';
  state.backoff = 1000;
  $('join-error').textContent = '';
  updateModeBadge();
  setStatus('connecting…');
  connect();
});

prefillSettings();

// ⚙ Settings — return to the launch screen to change mode/model/server later.
$('settings-btn')?.addEventListener('click', () => {
  state.wantReconnect = false;
  clearTimeout(state.retryTimer);
  state.transport?.close();
  showJoin('');
});

$('leave-btn').addEventListener('click', () => {
  // Leave must not depend on a close event: during a reconnect backoff the
  // socket is already CLOSED and close() fires nothing — cancel the pending
  // retry and go back to the join screen directly.
  state.wantReconnect = false;
  clearTimeout(state.retryTimer);
  state.transport?.close();
  showJoin('');
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('palette').hidden = true; closeCard(); closeCreator(); } });
