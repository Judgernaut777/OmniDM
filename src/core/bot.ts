/**
 * Bot core — the platform-agnostic router.
 *
 * Adapters hand it `IncomingMessage`s and a `send` callback. It knows nothing
 * about Discord or the terminal. It interprets `/dm ...` commands and routes
 * plain text from joined players into the turn pipeline.
 */
import type { Config } from '../config.js';
import type { GameSession, IncomingMessage, LLMProvider, OutgoingMessage, OutgoingRoll, Player, RollResult } from './types.js';
import { SessionManager, SeatTakenError } from './session/session-manager.js';
import type { SessionStorage } from './session/storage.js';
import { Narrator } from './narrator/narrator.js';
import type { CharacterCard } from './cards/card-parse.js';
import { findEntry, importCardBook, makeEntry } from './lore/lorebook.js';
import { splitFog } from './narrator/fog.js';
import { TurnPipeline } from './engine/turn-pipeline.js';
import { normalizeAbility, rollCheck } from './engine/dice.js';
import { applyDamage, applyHeal, findPartyMember } from './rules/mechanics.js';
import { classPreset, MAX_BIO_CHARS, normalizePresetId, PORTRAIT_PRESETS } from './portraits.js';
import { getBundledContentPack, listBundledContentPacks } from './content-packs/registry.js';
import { loadContentPack, PackLockedError } from './content-packs/loader.js';
import { selectEntitlements, type Entitlements } from './entitlements/entitlements.js';

type Send = (msg: OutgoingMessage) => Promise<void>;

/**
 * Strip API-key-shaped substrings out of arbitrary text before it is logged or
 * sent to players. Provider error bodies are attacker/misconfiguration-controlled
 * (a self-hosted OpenAI-compatible gateway can echo the submitted key in a 401
 * body; OpenAI's own "Incorrect API key provided: sk-…" does the same), and the
 * turn-failure notice built below is broadcast to every seat in server mode.
 */
export function redactSecrets(text: string): string {
  return String(text)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/gi, '$1-…redacted')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer …redacted')
    .replace(/\b(api[-_]?key|authorization|x-api-key)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{6,}/gi, '$1$2…redacted')
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, '…redacted');
}

/**
 * How `/dm import <src>` turns a source into a card. Injected so the core stays
 * Node-free: the Node host uses the default (a lazy import of ./cards/card.js,
 * with its URL/file/zlib machinery), while an in-app build passes a browser
 * importer that parses uploaded bytes. Because the default is a DYNAMIC import,
 * bot.ts's static module graph never references node: builtins.
 */
export type CardImporter = (source: string, baseDir: string) => Promise<CharacterCard>;

/**
 * The generic, ALLOWLISTED turn-failure notice shown to every seat in a
 * server-mode game. Server mode fans a single failure out to everyone in the
 * channel, including seats that are not the operator, so the provider's raw
 * error body (which can carry a misconfigured gateway's echoed key, an
 * internal hostname, a stack-shaped blob, etc.) must never reach the wire —
 * not even redacted-by-blocklist, which is only ever best-effort against
 * shapes it doesn't yet know. Exported so the web client can recognize this
 * exact notice and render it as a flagged line without needing to parse it.
 */
export const SERVER_TURN_FAILURE_TEXT =
  '⚠️ The DM couldn’t reach the model — the server operator should check the model/key/endpoint.';

export class Bot {
  private sessions: SessionManager;
  private pipeline: TurnPipeline;
  private entitlements: Entitlements;

  constructor(
    private config: Config,
    private provider: LLMProvider,
    storage: SessionStorage, // injected at the composition root so the core stays Node-free
    /** Card loader for `/dm import`; defaults to the Node loader (lazy-imported). */
    private cardImporter?: CardImporter,
    /**
     * 'server' (default): every Node-hosted adapter (CLI/Discord/Slack/Matrix/
     * Mattermost/web-server), where a turn failure is broadcast to every seat
     * in the channel — so only the generic {@link SERVER_TURN_FAILURE_TEXT} is
     * ever sent, never the provider's own error text.
     * 'local': the in-app browser engine ("Play on this device"), where the
     * failure notice never leaves the player's own device — so it stays the
     * detailed-but-scrubbed message, actionable for a solo player debugging
     * their own key/model/endpoint.
     */
    private mode: 'server' | 'local' = 'server',
  ) {
    this.sessions = new SessionManager(storage, config.llm.model, provider);
    const narrator = new Narrator(provider);
    this.pipeline = new TurnPipeline(this.sessions, narrator, provider);
    this.entitlements = selectEntitlements(config.monetization);
  }

  /** Resolve a card source. Uses the injected importer, else lazy-loads the Node one. */
  private async importCard(source: string, baseDir: string): Promise<CharacterCard> {
    if (this.cardImporter) return this.cardImporter(source, baseDir);
    const { loadCard } = await import('./cards/card.js');
    return loadCard(source, baseDir);
  }

  async handle(msg: IncomingMessage, send: Send): Promise<void> {
    const text = msg.text.trim();
    if (!text) return;

    try {
      if (text.startsWith('/dm') || text === '/help') {
        return await this.handleCommand(msg, text, send);
      }

      // Plain text → a play action, if this user is in the game.
      const session = await this.sessions.get(msg);
      if (!session) {
        return await send({ channelId: msg.channelId, text: '🎲 No game in this channel yet. Type `/dm new` to start one.' });
      }
      if (!this.sessions.isPlayer(session, msg.userId)) {
        return await send({ channelId: msg.channelId, text: `👀 You're spectating. Type \`/dm join <character name>\` to play.` });
      }

      await this.playAction(session, msg, text, send);
    } catch (err) {
      // Never let a provider/SDK error body carry a secret (or anything else)
      // into the room: some OpenAI-compatible gateways echo the submitted key
      // back in their 401 bodies. Always scrub before logging server-side.
      const detail = redactSecrets((err as Error)?.message || String(err));
      console.error('[bot] handle failed:', detail);
      // Server mode broadcasts this notice to every seat in the channel, most
      // of whom are not the operator — an allowlisted generic message, never
      // the provider body (redaction above is a blocklist and only a
      // best-effort backstop for the server-side log, not a gate on what's
      // sent). Local mode never leaves the player's own device, so the
      // scrubbed detail stays actionable there.
      const text = this.mode === 'local'
        ? `⚠️ The DM stumbled (model/call error): ${detail}\nCheck your LLM_API_KEY / model id, or try \`/dm models\`.`
        : SERVER_TURN_FAILURE_TEXT;
      await send({ channelId: msg.channelId, text });
    }
  }

  /**
   * A player takes an action. Round-robin order is checked (and advanced) by
   * the pipeline inside the channel lock, so a double-send from the current
   * player can't race the in-flight turn and consume someone else's.
   */
  private async playAction(session: GameSession, msg: IncomingMessage, text: string, send: Send): Promise<void> {
    const player = session.players[msg.userId];
    const result = await this.pipeline.processTurn(session, { actorName: name(player), text }, msg.userId);
    if (result.notYourTurn) {
      return await send({ channelId: msg.channelId, text: `⏳ It's ${name(result.notYourTurn)}'s turn — yours is coming up.` });
    }
    await this.broadcast(session, result.record!.narration, send, result.record!.rolls);
    if (result.next) await send({ channelId: msg.channelId, text: `➡️ Next up: ${name(result.next)}.` });
  }

  /**
   * Deliver a narration. With fog of war on, [PRIVATE:<Character>] sections are
   * stripped from the public text and whispered to that character's player
   * (via `targetUserId`); sections for unknown names are dropped silently.
   */
  private async broadcast(session: GameSession, narration: string, send: Send, rolls: RollResult[] = []): Promise<void> {
    // Deterministic rolls resolved this turn ride along on the PUBLIC narration
    // (never a whisper — dice outcomes are shared facts). Absent when no dice.
    const rollPayload = rolls.length ? rolls.map(toOutgoingRoll) : undefined;
    if (!session.fogOfWar) {
      return await send({ channelId: session.channelId, text: narration, speaker: 'Dungeon Master', ...(rollPayload ? { rolls: rollPayload } : {}) });
    }
    const { publicText, privates } = splitFog(narration);
    // Dice outcomes are shared facts, so the roll payload must ride on a PUBLIC
    // frame even when the whole narration was addressed to one character (empty
    // publicText). Falling back to a terse public roll line keeps text adapters
    // sane (never an empty message) and lets rich adapters animate/pop the die.
    const publicBody = publicText || (rollPayload ? rollLine(rollPayload) : '');
    if (publicBody) await send({ channelId: session.channelId, text: publicBody, speaker: 'Dungeon Master', ...(rollPayload ? { rolls: rollPayload } : {}) });
    for (const p of privates) {
      // Latest matching join wins: seat re-claims (session-manager) keep names
      // unique, but if they ever collide the most recent joiner is the live one
      // — the first match could be a dead userId whose whisper goes nowhere.
      const player = Object.values(session.players).reverse().find((pl) => name(pl).toLowerCase() === p.characterName.toLowerCase());
      if (!player) continue;
      await send({
        channelId: session.channelId,
        text: p.content,
        speaker: 'Dungeon Master',
        targetUserId: player.userId,
        targetUserName: player.userName,
      });
    }
  }

  private async handleCommand(msg: IncomingMessage, text: string, send: Send): Promise<void> {
    const parts = text.replace(/^\/dm\s*/, '').replace(/^\/help$/, 'help').trim().split(/\s+/);
    const cmd = (parts.shift() || 'help').toLowerCase();
    const rest = parts.join(' ');
    const reply = (t: string) => send({ channelId: msg.channelId, text: t });

    switch (cmd) {
      case 'help':
        return reply(HELP);

      case 'new': {
        const session = await this.sessions.create(msg);
        await this.sessions.join(session, msg);
        return reply(
          `🗡️ **A new campaign begins!** (model: \`${session.model}\`)\n` +
            `${msg.userName}, you've joined as yourself — set a character name with \`/dm join <name>\`.\n` +
            `Others can join with \`/dm join <name>\`. When ready, just describe what you do.`,
        );
      }

      case 'join': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        try {
          const player = await this.sessions.join(session, msg, rest || undefined);
          return reply(`✅ ${player.characterName || player.userName} joins the party.`);
        } catch (e) {
          if (e instanceof SeatTakenError) {
            return reply(
              `🚫 "${e.characterName}" is already claimed by another player. Pick a different name, ` +
              `or reconnect from the device that created that character.`,
            );
          }
          throw e;
        }
      }

      case 'who': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet.');
        const list = Object.values(session.players)
          .map((p) => `• ${p.characterName || p.userName} — HP ${p.hp}/${p.maxHp}`)
          .join('\n');
        return reply(`**The party:**\n${list || '(empty)'}`);
      }

      case 'hp': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet.');
        const list = Object.values(session.players)
          .map((p) => `• ${name(p)} — HP ${p.hp ?? '?'}/${p.maxHp ?? '?'}${p.conditions?.length ? ` (${p.conditions.join(', ')})` : ''}`)
          .join('\n');
        return reply(`**Party HP:**\n${list || '(empty)'}`);
      }

      case 'damage': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        const m = rest.match(/^(.+?)\s+(-?\d+)$/);
        if (!m) return reply('Usage: `/dm damage <character> <amount>` — e.g. `/dm damage Thorin 5`.');
        const target = findPartyMember(session, m[1]);
        if (!target) return reply(`No party member named "${m[1]}" — see \`/dm who\`.`);
        const amount = parseInt(m[2], 10);
        if (!Number.isFinite(amount) || amount < 0) return reply('Damage amount must be a non-negative number.');
        const change = applyDamage(target, amount);
        await this.sessions.save(session);
        const status = change.becameUnconscious ? ` — ${name(target)} drops to 0 HP and falls unconscious!` : '';
        return reply(`💥 ${name(target)} takes ${amount} damage: HP ${change.hp}/${change.maxHp}.${status}`);
      }

      case 'heal': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        const m = rest.match(/^(.+?)\s+(-?\d+)$/);
        if (!m) return reply('Usage: `/dm heal <character> <amount>` — e.g. `/dm heal Thorin 5`.');
        const target = findPartyMember(session, m[1]);
        if (!target) return reply(`No party member named "${m[1]}" — see \`/dm who\`.`);
        const amount = parseInt(m[2], 10);
        if (!Number.isFinite(amount) || amount < 0) return reply('Heal amount must be a non-negative number.');
        const change = applyHeal(target, amount);
        await this.sessions.save(session);
        const status = change.recovered ? ` — ${name(target)} regains consciousness!` : '';
        return reply(`💚 ${name(target)} heals ${amount}: HP ${change.hp}/${change.maxHp}.${status}`);
      }

      case 'import': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!rest) return reply('Usage: `/dm import <file-path-or-URL>` — a Character Card V2/V3 JSON or card PNG (local files must live under the data dir).');
        let card;
        try {
          card = await this.importCard(rest, this.config.dataDir);
        } catch (err) {
          return reply(`⚠️ Could not import that card: ${(err as Error).message}`);
        }
        const lore = importCardBook(session.lorebook, card.book ?? [], card.name);
        const loreNote = lore ? ` Imported ${lore} lorebook entr${lore === 1 ? 'y' : 'ies'} (see \`/dm lore list\`).` : '';
        if (this.sessions.isPlayer(session, msg.userId)) {
          const player = session.players[msg.userId];
          player.card = card;
          player.characterName = card.name;
          await this.sessions.save(session);
          return reply(`🎭 ${msg.userName} now plays **${card.name}** — imported card persona.${loreNote}`);
        }
        session.npcs.push(card);
        await this.sessions.save(session);
        return reply(`🧙 **${card.name}** enters the world as an NPC, portrayed by the DM.${loreNote}`);
      }

      case 'lore': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        const sub = (parts.shift() || 'list').toLowerCase();
        const arg = parts.join(' ');
        switch (sub) {
          case 'add': {
            const segs = arg.split('|');
            const entryName = segs[0]?.trim();
            const content = segs.slice(2).join('|').trim();
            if (segs.length < 3 || !entryName || !content)
              return reply('Usage: `/dm lore add <name> | <comma,separated,keywords> | <content>` (empty keywords = always injected).');
            const keywords = segs[1].split(',').map((k) => k.trim()).filter(Boolean);
            const entry = makeEntry(entryName, keywords, content);
            session.lorebook.push(entry);
            await this.sessions.save(session);
            return reply(`📖 Lore **${entry.name}** added (\`${entry.id}\`) — triggers on: ${keywords.join(', ') || '(always)'}.`);
          }
          case 'list': {
            const list = session.lorebook
              .map((e) => `• \`${e.id}\` **${e.name}** — ${e.keywords.join(', ') || '(always)'}${e.enabled ? '' : ' [disabled]'}`)
              .join('\n');
            return reply(`**Lorebook:**\n${list || '(empty — add with `/dm lore add <name> | <keywords> | <content>`)'}`);
          }
          case 'remove': {
            const entry = arg ? findEntry(session.lorebook, arg) : undefined;
            if (!entry) return reply(`No lore entry matches \`${arg || '(nothing)'}\` — see \`/dm lore list\`.`);
            session.lorebook.splice(session.lorebook.indexOf(entry), 1);
            await this.sessions.save(session);
            return reply(`🗑️ Lore **${entry.name}** removed.`);
          }
          default:
            return reply('Lore commands: `/dm lore add <name> | <keywords> | <content>`, `/dm lore list`, `/dm lore remove <id-or-name>`.');
        }
      }

      case 'pack': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        const sub = (parts.shift() || 'list').toLowerCase();
        const arg = parts.join(' ').trim();
        if (sub === 'list') {
          const packs = listBundledContentPacks();
          const list = packs
            .map((p) => `• \`${p.id}\` **${p.name}** v${p.version}${p.premium ? ' 🔒 premium' : ''}${this.entitlements.isUnlocked(p.id) ? '' : ' (locked)'} — ${p.description || ''}`)
            .join('\n');
          return reply(`**Content packs:**\n${list || '(none bundled)'}\nLoad one with \`/dm pack load <id>\`.`);
        }
        if (sub === 'load') {
          const pack = arg ? getBundledContentPack(arg) : undefined;
          if (!pack) return reply(`No bundled content pack matches \`${arg || '(nothing)'}\` — see \`/dm pack list\`.`);
          try {
            const result = loadContentPack(pack, session, this.entitlements);
            await this.sessions.save(session);
            const bits = [
              result.lorebookAdded ? `${result.lorebookAdded} lore entr${result.lorebookAdded === 1 ? 'y' : 'ies'}` : '',
              result.npcsAdded ? `${result.npcsAdded} NPC${result.npcsAdded === 1 ? '' : 's'}` : '',
              result.rulesRegistered ? 'a rules module' : '',
              result.starterApplied ? 'its campaign starter' : '',
            ].filter(Boolean);
            return reply(`📦 Loaded **${pack.name}** — added ${bits.join(', ') || 'nothing new (already loaded)'}.`);
          } catch (e) {
            if (e instanceof PackLockedError) return reply(`🔒 **${pack.name}** is a premium content pack and isn't unlocked here.`);
            throw e;
          }
        }
        return reply('Pack commands: `/dm pack list`, `/dm pack load <id>`.');
      }

      case 'models': {
        const models = await this.provider.listModels();
        if (!models.length) return reply('Could not list models (check LLM_BASE_URL / LLM_API_KEY). You can still set one with `/dm model <id>`.');
        const filtered = rest ? models.filter((m) => m.id.toLowerCase().includes(rest.toLowerCase())) : models;
        const free = filtered.filter((m) => m.free).slice(0, 15);
        const shown = (free.length ? free : filtered.slice(0, 15))
          .map((m) => `• \`${m.id}\`${m.free ? ' 🆓' : ''}`)
          .join('\n');
        return reply(`**Available models** (showing ${free.length ? 'free' : 'first 15'}${rest ? `, matching "${rest}"` : ''}):\n${shown}\n\nSet one with \`/dm model <id>\`.`);
      }

      case 'model': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!rest) return reply(`Current model: \`${session.model}\`. Change with \`/dm model <id>\` (see \`/dm models\`).`);
        if (this.provider.supportsModel && !this.provider.supportsModel(rest))
          return reply(`⚠️ The active provider (\`${this.provider.id}\`) can't serve \`${rest}\` — see \`/dm models\`.`);
        session.model = rest;
        await this.sessions.save(session);
        return reply(`🤖 Model set to \`${rest}\` for this game.`);
      }

      case 'roll': {
        const session = await this.sessions.get(msg);
        if (!session || !this.sessions.isPlayer(session, msg.userId))
          return reply('Join a game first with `/dm new` or `/dm join <name>`.');
        return await this.playAction(session, msg, rest || 'd20', send);
      }

      case 'check': {
        const session = await this.sessions.get(msg);
        if (!session || !this.sessions.isPlayer(session, msg.userId))
          return reply('Join a game first with `/dm new` or `/dm join <name>`.');
        const m = rest.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)(?:\s+(-?\d+))?$/);
        if (!m) return reply('Usage: `/dm check <character> <ABILITY> <DC> [modifier]` — e.g. `/dm check Thorin STR 15`.');
        const target = findPartyMember(session, m[1]);
        if (!target) return reply(`No party member named "${m[1]}" — see \`/dm who\`.`);
        const ability = normalizeAbility(m[2]);
        if (!ability) return reply('Ability must be one of STR, DEX, CON, INT, WIS, CHA.');
        const dc = parseInt(m[3], 10);
        const modifier = m[4] ? parseInt(m[4], 10) : 0;
        // The engine resolves the check BEFORE narration — same "resolve, then
        // narrate" pattern as dice — so the model states PASS/FAIL, never decides it.
        const checkResult = rollCheck(ability, dc, modifier, name(target));
        const text = `attempts a ${ability} check (DC ${dc})`;
        const result = await this.pipeline.processTurn(session, { actorName: name(target), text, checks: [checkResult] }, msg.userId);
        if (result.notYourTurn) {
          return await send({ channelId: msg.channelId, text: `⏳ It's ${name(result.notYourTurn)}'s turn — yours is coming up.` });
        }
        await this.broadcast(session, result.record!.narration, send, result.record!.rolls);
        if (result.next) await send({ channelId: msg.channelId, text: `➡️ Next up: ${name(result.next)}.` });
        return;
      }

      case 'mode': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!rest) return reply(`Turn mode: \`${session.turnMode}\`. Change with \`/dm mode <immediate|round-robin>\`.`);
        if (rest !== 'immediate' && rest !== 'round-robin') return reply('Turn mode must be `immediate` or `round-robin`.');
        session.turnMode = rest;
        await this.sessions.save(session);
        if (rest === 'immediate') return reply('⚡ Immediate mode — every message is a turn.');
        const current = this.sessions.currentPlayer(session);
        return reply(`🔄 Round-robin mode — players act in join order.${current ? ` It's ${name(current)}'s turn.` : ''}`);
      }

      case 'class': {
        // No arg lists the 12 classes (no game needed); setting one requires a
        // seat (class lives on the Player, like the portrait it defaults).
        if (!rest) {
          return reply(
            `🧝 **D&D 5e classes:** ${PORTRAIT_PRESETS.join(', ')}\n` +
              `Set yours with \`/dm class <name>\` (e.g. \`/dm class wizard\`). This also picks a matching portrait unless you've uploaded your own.`,
          );
        }
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!this.sessions.isPlayer(session, msg.userId))
          return reply('Join first with `/dm join <name>` to set your class.');
        const id = normalizePresetId(rest);
        if (!id) return reply(`Unknown class \`${rest}\`. Choose one of: ${PORTRAIT_PRESETS.join(', ')}.`);
        const player = session.players[msg.userId];
        player.class = id;
        // Default the preset portrait to the class — unless the player already
        // has a real picture (an upload OR embedded card art), which we keep.
        const hasImage = player.portrait?.kind === 'image' || player.card?.portrait?.kind === 'image';
        if (!hasImage) player.portrait = { kind: 'preset', id };
        await this.sessions.save(session);
        const preset = classPreset(id);
        return reply(`🧝 You are now a **${preset.name}** — ${preset.flavor}.`);
      }

      case 'bio': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!this.sessions.isPlayer(session, msg.userId))
          return reply('Join first with `/dm join <name>` to set a bio.');
        const player = session.players[msg.userId];
        if (!rest) {
          return reply(
            player.bio
              ? `📜 Your bio: ${player.bio}`
              : 'Usage: `/dm bio <a short description of your character>` — a lightweight persona if you have no imported card.',
          );
        }
        player.bio = rest.length > MAX_BIO_CHARS ? rest.slice(0, MAX_BIO_CHARS) : rest;
        await this.sessions.save(session);
        return reply(`📜 Bio set (${player.bio.length} chars).`);
      }

      case 'portrait': {
        // Listing needs no game; setting one requires a seat (portraits live on
        // the Player). Image uploads happen out-of-band over HTTP (web adapter).
        if (!rest) {
          return reply(
            `🖼️ **Portrait presets:** ${PORTRAIT_PRESETS.join(', ')}\n` +
              `Set yours with \`/dm portrait <id>\` (e.g. \`/dm portrait fighter\`), or upload your own picture in the browser.`,
          );
        }
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!this.sessions.isPlayer(session, msg.userId))
          return reply('Join first with `/dm join <name>` to set your portrait.');
        const id = normalizePresetId(rest);
        if (!id) return reply(`Unknown preset \`${rest}\`. Choose one of: ${PORTRAIT_PRESETS.join(', ')}.`);
        session.players[msg.userId].portrait = { kind: 'preset', id };
        await this.sessions.save(session);
        return reply(`🖼️ Portrait set to the **${id}** preset.`);
      }

      case 'fog': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!rest) return reply(`Fog of war is \`${session.fogOfWar ? 'on' : 'off'}\`. Change with \`/dm fog <on|off>\`.`);
        if (rest !== 'on' && rest !== 'off') return reply('Fog of war must be `on` or `off`.');
        session.fogOfWar = rest === 'on';
        await this.sessions.save(session);
        return reply(
          session.fogOfWar
            ? '🌫️ Fog of war ON — the DM may whisper private details to individual characters.'
            : '☀️ Fog of war OFF — all narration is shared with the whole party.',
        );
      }

      case 'turn': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet.');
        if (session.turnMode !== 'round-robin') return reply('Turn mode is `immediate` — anyone can act anytime.');
        const current = this.sessions.currentPlayer(session);
        return reply(current ? `🎯 It's ${name(current)}'s turn.` : 'The party is empty — `/dm join <name>` first.');
      }

      case 'pass': {
        const session = await this.sessions.get(msg);
        if (!session || !this.sessions.isPlayer(session, msg.userId))
          return reply('Join a game first with `/dm new` or `/dm join <name>`.');
        if (session.turnMode !== 'round-robin') return reply('Nothing to pass — turn mode is `immediate`.');
        // Check-and-advance runs in the pipeline's channel lock so a pass can't
        // double-advance the pointer while a turn is resolving.
        const result = await this.pipeline.pass(session, msg.userId);
        if (result.notYourTurn) return reply(`⏳ It's ${name(result.notYourTurn)}'s turn, not yours.`);
        return reply(`⏭️ ${name(session.players[msg.userId])} passes.${result.next ? ` Next up: ${name(result.next)}.` : ''}`);
      }

      case 'end': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here to end.');
        // Must go through the shared manager/store: deleting via a fresh store
        // leaves the live cache populated and the next message resurrects the game.
        await this.sessions.end(msg);
        return reply('🏁 Campaign ended and saved out. `/dm new` to start fresh.');
      }

      default:
        return reply(`Unknown command \`${cmd}\`. Try \`/dm help\`.`);
    }
  }
}

const name = (p: Player) => p.characterName || p.userName;

/**
 * A terse, PUBLIC one-line summary of the dice a turn resolved. Used only as the
 * public body when fog mode routed the entire narration to a whisper: the dice
 * result is still a shared fact and must reach the room (and text adapters that
 * ignore the structured `rolls`), never leak into (or vanish behind) the whisper.
 */
function rollLine(rolls: OutgoingRoll[]): string {
  return rolls
    .map((r) => `🎲 ${r.actor} rolls ${r.notation}: ${r.total}${r.note ? ` (${r.note})` : ''}`)
    .join('\n');
}

/**
 * Project an engine `RollResult` onto the wire `OutgoingRoll`. The modifier is
 * recovered as `total − sum(kept dice)` (the engine folds it into `total`), so
 * a rich adapter can render dice + modifier without re-deriving or re-rolling.
 */
function toOutgoingRoll(r: RollResult): OutgoingRoll {
  const sum = r.rolls.reduce((s, x) => s + x, 0);
  const modifier = r.total - sum;
  return {
    notation: r.notation,
    dice: r.rolls,
    total: r.total,
    actor: r.by,
    ...(modifier ? { modifier } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
}

const HELP = `**OmniDM — commands**
\`/dm new\` — start a campaign in this channel
\`/dm join <name>\` — join with a character name
\`/dm who\` — show the party
\`/dm mode <immediate|round-robin>\` — how turns are taken
\`/dm turn\` — show whose turn it is (round-robin)
\`/dm fog <on|off>\` — per-player fog of war: the DM can whisper private details to one character
\`/dm pass\` — skip your turn (round-robin)
\`/dm class [<name>]\` — set your D&D 5e class (no arg lists all 12); also picks a matching portrait
\`/dm bio [<text>]\` — set a short character bio/persona (no arg shows yours)
\`/dm portrait [<preset>]\` — set your portrait to a class preset (no arg lists them); upload your own picture in the browser
\`/dm import <file-or-URL>\` — import a Character Card V2/V3 (JSON or PNG): your persona if joined, an NPC otherwise
\`/dm lore add <name> | <keywords> | <content>\` — world info, injected when a keyword comes up (also \`list\`, \`remove <id-or-name>\`)
\`/dm pack list\` — list bundled content packs (rules + lorebook + NPCs + a campaign starter); \`/dm pack load <id>\` to import one
\`/dm models [filter]\` — list models you can use (🆓 = free)
\`/dm model <id>\` — pick the model for this game
\`/dm roll <notation>\` — roll dice (e.g. \`d20+5\`, \`2d6\`, \`d20 adv\`)
\`/dm hp\` — show the party's HP and conditions
\`/dm damage <character> <n>\` / \`/dm heal <character> <n>\` — apply mechanical damage/healing
\`/dm check <character> <ABILITY> <DC> [modifier]\` — engine-rolled d20 check vs a DC (STR/DEX/CON/INT/WIS/CHA)
\`/dm end\` — end the campaign
Otherwise, just type what your character does.`;
