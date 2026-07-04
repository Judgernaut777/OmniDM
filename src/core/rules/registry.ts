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
 * Rules modules registered AT RUNTIME by content packs (see
 * `content-packs/loader.ts`). Kept separate from {@link BUNDLED_RULES} (the
 * compiled-in set) so a pack can add a homebrew system without touching that
 * static catalog. Checked first, so a pack could also intentionally override
 * a bundled system id.
 */
const runtimeRules: Record<string, string> = {};

/** Register (or replace) a rules module's markdown under `systemId` — what content packs call to add their own system. */
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
