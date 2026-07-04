/**
 * Rules registry — the browser-safe seam for the narrator's system modules.
 *
 * The narrator used to read `rules/<system>/system.md` off disk via node:fs, a
 * hard blocker for running the engine in a WebView. Instead the rules markdown
 * is BUNDLED as string modules and looked up through a `RulesProvider`. The
 * default provider is pure (no node imports), so the engine path is portable;
 * a Node host can still inject a filesystem-backed provider if it wants the old
 * "drop a markdown file" behaviour (see `NodeRulesProvider` in ../session? — no,
 * this stays dependency-free; the composition root can supply one).
 */
import { DND5E_SYSTEM } from './dnd5e.system.js';

/** Resolves a system module's markdown by its id (e.g. "dnd5e"). */
export interface RulesProvider {
  /** The rules markdown for `systemId`, or '' when unknown (the narrator omits it). */
  system(systemId: string): string;
}

/** The bundled rules modules, keyed by system id. Add a system = add an entry. */
export const BUNDLED_RULES: Record<string, string> = {
  dnd5e: DND5E_SYSTEM,
};

/**
 * Rules modules registered explicitly, process-wide, by the HOST (not by
 * content packs — `content-packs/loader.ts` attaches a pack's rules module to
 * the importing `GameSession` itself, via `session.customRules`, precisely so
 * that loading a pack in one session never leaks into or collides with any
 * other session in the same process). This registry remains as a deliberate,
 * opt-in seam for an operator who wants to add a homebrew system for the
 * WHOLE deployment (e.g. at boot, before any session exists) without
 * touching the compiled-in {@link BUNDLED_RULES} catalog. Checked first, so
 * it can also intentionally override a bundled system id — that's on the
 * operator calling it, not on any one session's content.
 */
const runtimeRules: Record<string, string> = {};

/**
 * Register (or replace) a rules module's markdown under `systemId`,
 * PROCESS-WIDE, for every session the host ever serves. This is a low-level,
 * intentionally global operation for a host/operator's own boot-time setup —
 * it is NOT what importing a per-session content pack uses (see
 * `content-packs/loader.ts` / `GameSession.customRules` for that isolated
 * path). Calling this with an id that collides with another registration (or
 * a bundled system id) silently overwrites it for the whole process.
 */
export function registerRulesModule(systemId: string, markdown: string): void {
  runtimeRules[systemId] = markdown;
}

/** Testing/reset hook: drop all runtime-registered rules modules. */
export function clearRuntimeRules(): void {
  for (const key of Object.keys(runtimeRules)) delete runtimeRules[key];
}

/** The default, dependency-free rules provider backed by runtime + {@link BUNDLED_RULES}. */
export const bundledRulesProvider: RulesProvider = {
  system(systemId: string): string {
    return runtimeRules[systemId] ?? BUNDLED_RULES[systemId] ?? '';
  },
};
