/**
 * Bot core — the platform-agnostic router.
 *
 * Adapters hand it `IncomingMessage`s and a `send` callback. It knows nothing
 * about Discord or the terminal. It interprets `/dm ...` commands and routes
 * plain text from joined players into the turn pipeline.
 */
import type { Config } from '../config.js';
import type { GameSession, IncomingMessage, LLMProvider, OutgoingMessage, Player } from './types.js';
import { SessionManager } from './session/session-manager.js';
import { SessionStore } from './session/store.js';
import { Narrator } from './narrator/narrator.js';
import { loadCard } from './cards/card.js';
import { TurnPipeline } from './engine/turn-pipeline.js';

type Send = (msg: OutgoingMessage) => Promise<void>;

export class Bot {
  private sessions: SessionManager;
  private pipeline: TurnPipeline;

  constructor(
    private config: Config,
    private provider: LLMProvider,
  ) {
    const store = new SessionStore(config.dataDir);
    this.sessions = new SessionManager(store, config.llm.model);
    const narrator = new Narrator(provider);
    this.pipeline = new TurnPipeline(this.sessions, narrator, provider);
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
      const detail = (err as Error)?.message || String(err);
      console.error('[bot] handle failed:', detail);
      await send({
        channelId: msg.channelId,
        text: `⚠️ The DM stumbled (model/call error): ${detail}\nCheck your LLM_API_KEY / model id, or try \`/dm models\`.`,
      });
    }
  }

  /** A player takes an action: enforce round-robin order, run the turn, advance. */
  private async playAction(session: GameSession, msg: IncomingMessage, text: string, send: Send): Promise<void> {
    if (session.turnMode === 'round-robin') {
      const current = this.sessions.currentPlayer(session);
      if (current && current.userId !== msg.userId) {
        return await send({ channelId: msg.channelId, text: `⏳ It's ${name(current)}'s turn — yours is coming up.` });
      }
    }
    const player = session.players[msg.userId];
    const record = await this.pipeline.processTurn(session, { actorName: name(player), text });
    await send({ channelId: msg.channelId, text: record.narration, speaker: 'Dungeon Master' });
    if (session.turnMode === 'round-robin') {
      const next = await this.sessions.advanceTurn(session);
      if (next) await send({ channelId: msg.channelId, text: `➡️ Next up: ${name(next)}.` });
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
        const player = await this.sessions.join(session, msg, rest || undefined);
        return reply(`✅ ${player.characterName || player.userName} joins the party.`);
      }

      case 'who': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet.');
        const list = Object.values(session.players)
          .map((p) => `• ${p.characterName || p.userName} — HP ${p.hp}/${p.maxHp}`)
          .join('\n');
        return reply(`**The party:**\n${list || '(empty)'}`);
      }

      case 'import': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here yet — `/dm new` first.');
        if (!rest) return reply('Usage: `/dm import <file-path-or-URL>` — a Character Card V2/V3 JSON or card PNG.');
        let card;
        try {
          card = await loadCard(rest);
        } catch (err) {
          return reply(`⚠️ Could not import that card: ${(err as Error).message}`);
        }
        if (this.sessions.isPlayer(session, msg.userId)) {
          const player = session.players[msg.userId];
          player.card = card;
          player.characterName = card.name;
          await this.sessions.save(session);
          return reply(`🎭 ${msg.userName} now plays **${card.name}** — imported card persona.`);
        }
        session.npcs.push(card);
        await this.sessions.save(session);
        return reply(`🧙 **${card.name}** enters the world as an NPC, portrayed by the DM.`);
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
        const current = this.sessions.currentPlayer(session);
        if (current && current.userId !== msg.userId) return reply(`⏳ It's ${name(current)}'s turn, not yours.`);
        const next = await this.sessions.advanceTurn(session);
        return reply(`⏭️ ${name(session.players[msg.userId])} passes.${next ? ` Next up: ${name(next)}.` : ''}`);
      }

      case 'end': {
        const session = await this.sessions.get(msg);
        if (!session) return reply('No game here to end.');
        await new SessionStore(this.config.dataDir).delete(this.sessions.key(msg));
        return reply('🏁 Campaign ended and saved out. `/dm new` to start fresh.');
      }

      default:
        return reply(`Unknown command \`${cmd}\`. Try \`/dm help\`.`);
    }
  }
}

const name = (p: Player) => p.characterName || p.userName;

const HELP = `**OmniDM — commands**
\`/dm new\` — start a campaign in this channel
\`/dm join <name>\` — join with a character name
\`/dm who\` — show the party
\`/dm mode <immediate|round-robin>\` — how turns are taken
\`/dm turn\` — show whose turn it is (round-robin)
\`/dm pass\` — skip your turn (round-robin)
\`/dm import <file-or-URL>\` — import a Character Card V2/V3 (JSON or PNG): your persona if joined, an NPC otherwise
\`/dm models [filter]\` — list models you can use (🆓 = free)
\`/dm model <id>\` — pick the model for this game
\`/dm roll <notation>\` — roll dice (e.g. \`d20+5\`, \`2d6\`, \`d20 adv\`)
\`/dm end\` — end the campaign
Otherwise, just type what your character does.`;
