# Monetization scaffold

OmniDM ships **self-hosted and free today**. This document describes the
scaffold for the two commercial levers the project is designed to grow into —
**a hosted tier** and **content packs** — and exactly how much of that is real
right now versus left for an operator to wire up.

Nothing here is a billing system. There is no payment processor integration,
no account system, no server-side purchase flow. What exists is the seam a
real billing integration would sit behind, built so that:

- self-hosting stays fully-featured and free, forever — the code path that
  gates anything is opt-in and off by default;
- a pack author can ship real content in a real, validated format today; and
- a future hosted operator has a single, obvious place to wire in billing
  without re-architecting the engine.

## The model

**Hosted tier.** OmniDM is free and open to self-host. A hosted deployment
(someone running OmniDM as a service for players who don't want to run their
own server/API key) is a natural place to charge for convenience — compute,
uptime, not needing your own LLM key. That's a subscription/usage decision an
operator makes; this repo doesn't take a position on price or plan shape.

**Content packs.** A content pack is a shareable, versioned bundle of game
content: a rules/system module, lorebook entries, NPCs, and an optional
campaign starter. Free packs are just content. A **premium** pack is the same
format with `"premium": true` — the natural unit to sell (a curated setting,
a homebrew ruleset, a ready-to-run one-shot) without touching engine code.

## Content-pack format

A pack is one JSON file (schema below), validated by
[`src/core/content-packs/validate.ts`](src/core/content-packs/validate.ts) and
imported into a session by
[`src/core/content-packs/loader.ts`](src/core/content-packs/loader.ts). It
reuses the engine's own types — a pack's lorebook entries become real
`LoreEntry` records, its NPCs become real `CharacterCard`s, its rules module is
registered exactly like the bundled D&D 5e module — a pack is just a bulk way
to fill in the same session state `/dm lore add`, `/dm import`, and a system
module already populate one at a time.

```jsonc
{
  "formatVersion": 1,              // the SCHEMA version (this doc). Bumped only
                                    // if this shape changes; a pack from an
                                    // unsupported formatVersion is refused outright.
  "id": "frontier-outpost",         // short kebab-case id — also the entitlement
                                    // key a premium pack gates on
  "name": "Frontier Outpost",
  "version": "1.0.0",               // the PACK author's own semver
  "description": "...",             // optional
  "author": "...",                  // optional
  "premium": true,                  // optional, default false — see Entitlements below

  "rulesModule": {                  // optional: a homebrew system module
    "id": "frontier-lite",          // the systemId a session using this pack sets
    "name": "Frontier Lite",
    "markdown": "# System Module — ..."   // same shape as the narrator's bundled
                                           // system prompts (see rules/dnd5e.system.ts)
  },

  "lorebook": [                     // optional, [] default
    { "name": "...", "keywords": ["..."], "content": "...", "enabled": true }
  ],

  "npcs": [                         // optional, [] default — minimal CharacterCard fields
    { "name": "...", "description": "...", "personality": "...", "scenario": "...",
      "firstMes": "...", "mesExample": "...", "systemPrompt": "..." }
  ],

  "campaignStarter": {              // optional: a ready-to-play opening
    "title": "...",
    "summary": "...",               // seeds the session's rolling summary
    "openingNarration": "...",      // recorded as the session's first turn
    "systemId": "frontier-lite"     // switches a FRESH session to this pack's system
  }
}
```

One real example ships at
[`content-packs/frontier-outpost.pack.json`](content-packs/frontier-outpost.pack.json)
— an original one-shot setting (no third-party/WotC IP; the rules module is
original homebrew text, not reproduced SRD/OGL content) with a rules module,
five lorebook entries, two NPCs, and a campaign starter. It's marked
`"premium": true` specifically so the entitlements gate below has something
real to demonstrate — see [Entitlements](#entitlements).

**Validation** ([`validate.ts`](src/core/content-packs/validate.ts)) treats
every pack as untrusted input (packs can come from a marketplace later, same
threat model as Character Cards): every field is length/shape-checked, every
collection is capped (200 lorebook entries, 50 NPCs, etc.), and a rejection
message never echoes the raw input back.

**Loading** ([`loader.ts`](src/core/content-packs/loader.ts)) is idempotent —
importing the same pack twice adds nothing the second time — and additive: it
only ever appends to a session's lorebook/NPCs and only applies a campaign
starter to a session with no history yet. A locked premium pack throws before
touching the session at all (no partial import).

In-app, run `/dm pack list` to see bundled packs and `/dm pack load <id>` to
import one into the current game.

## Entitlements

[`src/core/entitlements/entitlements.ts`](src/core/entitlements/entitlements.ts)
defines the pluggable gate:

```ts
interface Entitlements {
  readonly id: string;
  isUnlocked(key: string): boolean; // a content pack id, or a future feature key
}
```

Two implementations ship:

- **`selfHostEntitlements`** — unlocks everything. This is the default and the
  only thing wired up in `npm run cli` / `npm run web` / the desktop/mobile
  builds today: an operator running their own server owns their own data, so
  there is nothing to gate.
- **`createHostedEntitlements(cfg)`** — a **stub** for a future hosted tier.
  It gates on a static allowlist (`unlockedKeys`, or `'*'` for everything), but
  only when `enforcePremium` is explicitly set — a hosted flag with no real
  billing behind it must never lock a real player out by accident.

`selectEntitlements(config.monetization)` picks between them from config:

| Env var | Default | Effect |
|---|---|---|
| `OMNIDM_HOSTED_TIER` | unset (self-host) | `1`/`true` switches on the hosted stub's enforcement |
| `OMNIDM_UNLOCKED_PACKS` | unset (`[]`) | comma-separated pack ids unlocked under the hosted stub; `*` unlocks everything |

The `Bot` reads this once at construction (`this.entitlements =
selectEntitlements(config.monetization)`) and gates `/dm pack load` with it —
`loadContentPack(pack, session, entitlements)` throws `PackLockedError` for a
premium pack the caller's entitlements don't unlock.

## Wiring in real billing later

None of the above talks to a payment processor. To turn the hosted stub into
a real product:

1. Stand up whatever billing/accounts system you want (Stripe, a license
   server, your own DB of purchased pack ids per user/org).
2. Replace `createHostedEntitlements`'s static `unlockedKeys` set with a real
   lookup — `isUnlocked(packId)` becomes a query against your billing/purchase
   store (per-user, per-org, or per-deployment, however you sell it), instead
   of a config-file allowlist. The `Entitlements` interface doesn't change;
   only what's behind it does.
3. Set `OMNIDM_HOSTED_TIER=1` (or otherwise pass `{ hosted: true, ... }` into
   `selectEntitlements`) to switch a deployment from "self-host, everything
   unlocked" to "hosted, gate on real entitlements."
4. Ship more content packs — free ones to grow the catalog, premium ones
   (`"premium": true`) as the thing a purchase unlocks. The pack format and
   loader don't change; only how many packs exist and which ones are gated.

Nothing about self-hosting changes: `selfHostEntitlements` stays the default
for anyone running their own server, and step 3 is the only switch that turns
enforcement on at all.
