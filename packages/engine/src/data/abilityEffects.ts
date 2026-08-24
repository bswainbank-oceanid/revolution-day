import type { AbilityDefinition } from "../effects/dsl";

// Maps a card's defRef to its Activate/Response abilities' structured
// effects, in the same order as card_data.json's `abilities` array for
// that card. Only a handful of the simplest (single-effect, exact-count
// `eliminate`) abilities are encoded so far, to prove the interpreter
// pipeline end to end — activateAbility/useResponse throw a clear "not yet
// encoded" error for anything else rather than pretending full content
// coverage exists. The remaining ~24 cards are unstarted content work, not
// a design gap (see rev_day_engine_design memory).
const eliminateOneAtSelf = (faction?: "Regime" | "Rebel") =>
  ({
    verb: "eliminate" as const,
    target: {
      ref: "filter" as const,
      location: { mode: "self" as const },
      count: { mode: "exact" as const, value: 1 },
      selection: "playerChoice" as const,
      ...(faction ? { faction } : {}),
    },
  });

// "Activate any [faction] card, controlled by any player, at any
// location" — no location/controller filter at all (unrestricted means
// unfiltered, same convention as an omitted faction/kind filter).
const activateRemoteNonLeader = (faction?: "Regime" | "Rebel") =>
  ({
    verb: "activateRemote" as const,
    count: { mode: "exact" as const, value: 1 },
    target: {
      ref: "filter" as const,
      kind: "nonLeader" as const,
      count: { mode: "exact" as const, value: 1 },
      selection: "playerChoice" as const,
      ...(faction ? { faction } : {}),
    },
  });

const eliminateOneOrTwoAtSelf = (faction?: "Regime" | "Rebel") =>
  ({
    verb: "eliminate" as const,
    target: {
      ref: "filter" as const,
      location: { mode: "self" as const },
      count: { mode: "range" as const, min: 1, max: 2 },
      selection: "playerChoice" as const,
      ...(faction ? { faction } : {}),
    },
  });

// A card's array here may have gaps (e.g. Puppet-Master's remote-activate
// is its second ability) — an un-encoded index is simply absent/undefined,
// not a placeholder value, so getAbilityEffects reports it the same way
// as a wholly unencoded card.
export const abilityEffects: Record<string, readonly (AbilityDefinition | undefined)[]> = {
  "Republican Guard": [{ type: "Activate", effects: [eliminateOneAtSelf()] }],
  Assassin: [
    { type: "Activate", effects: [eliminateOneAtSelf()] },
    { type: "Response", effects: [eliminateOneAtSelf()] },
  ],
  // Response abilities are only ever usable during an alarm's response
  // window (see rev_day_engine_design memory) — Bodyguard has no Activate
  // ability at all, its sole purpose is reacting to others' alarms.
  Bodyguard: [{ type: "Response", effects: [eliminateOneAtSelf("Rebel")] }],
  Gunman: [
    { type: "Activate", alarm: true, effects: [eliminateOneAtSelf()] },
    { type: "Response", effects: [eliminateOneAtSelf("Regime")] },
  ],
  Wife: [
    {
      type: "Activate",
      effects: [
        {
          verb: "eliminate",
          ignoreProtected: true,
          target: {
            ref: "filter",
            kind: "president",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
      ],
    },
  ],
  "Head of Security": [{ type: "Activate", effects: [activateRemoteNonLeader("Regime")] }],
  "Guerrilla Commander": [
    { type: "Activate", effects: [activateRemoteNonLeader("Rebel")] },
    // "Reveal a blended target. If it is a regime card, eliminate it. If
    // it is a non-leader rebel card, gain control of it." — an "else if"
    // (a rebel *leader*, e.g. Puppet-Master, matches neither branch and
    // nothing happens), expressed as a nested `if` inside the outer
    // else — see applyIfEffect's recursive dispatch in reducer.ts.
    {
      type: "Activate",
      effects: [
        {
          verb: "reveal",
          bind: "target",
          target: {
            ref: "filter",
            location: { mode: "self" },
            blendState: "faceDown",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
        {
          verb: "if",
          condition: {
            op: "equals",
            left: { source: "binding", binding: "target", field: "faction" },
            value: "Regime",
          },
          then: [{ verb: "eliminate", target: { ref: "binding", binding: "target" } }],
          else: [
            {
              verb: "if",
              condition: {
                op: "and",
                conditions: [
                  { op: "equals", left: { source: "binding", binding: "target", field: "kind" }, value: "nonLeader" },
                  { op: "equals", left: { source: "binding", binding: "target", field: "faction" }, value: "Rebel" },
                ],
              },
              then: [{ verb: "gainControl", target: { ref: "binding", binding: "target" } }],
            },
          ],
        },
      ],
    },
  ],
  // Puppet-Master's remote-activate is its *second* ability — index 0
  // ("Play 2 cards") isn't encoded, so this array has a gap.
  "Puppet-Master": [undefined, { type: "Activate", effects: [activateRemoteNonLeader()] }],
  "Death Squad": [
    { type: "Activate", alarm: true, effects: [eliminateOneOrTwoAtSelf()] },
    { type: "Response", effects: [eliminateOneOrTwoAtSelf()] },
  ],
  "Commander General": [
    {
      type: "Activate",
      effects: [
        {
          verb: "play",
          location: { mode: "self" },
          ignoreLocationRestrictions: true,
          target: {
            ref: "filter",
            faction: "Regime",
            count: { mode: "unbounded" },
            selection: "playerChoice",
          },
        },
      ],
    },
    {
      type: "Activate",
      effects: [
        {
          verb: "activateRemote",
          count: { mode: "unbounded" },
          target: {
            ref: "filter",
            kind: "nonLeader",
            faction: "Regime",
            controller: "self",
            location: { mode: "self" },
            count: { mode: "unbounded" },
            selection: "playerChoice",
          },
        },
      ],
    },
    {
      type: "Activate",
      effects: [
        {
          verb: "reveal",
          target: {
            ref: "filter",
            location: { mode: "self" },
            blendState: "faceDown",
            count: { mode: "all" },
            selection: "playerChoice",
          },
        },
      ],
    },
  ],
  // Full 3-step sequence, walked in order by AbilityResolutionFrame.effectIndex
  // (see rev_day_engine_design memory): force-reveal every blended+Protected
  // character at the location (so the random draw below can't be skewed by
  // hidden Protected status), randomly eliminate 4 (protected cards only if
  // there's no other choice), then eliminate the Bomber itself.
  "Secret Police": [
    // "Reveal a blended target. If it is a rebel, eliminate it. If it is
    // regime, eliminate this card instead."
    {
      type: "Activate",
      effects: [
        {
          verb: "reveal",
          bind: "target",
          target: {
            ref: "filter",
            location: { mode: "self" },
            blendState: "faceDown",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
        {
          verb: "if",
          condition: {
            op: "equals",
            left: { source: "binding", binding: "target", field: "faction" },
            value: "Rebel",
          },
          then: [{ verb: "eliminate", target: { ref: "binding", binding: "target" } }],
          else: [{ verb: "eliminate", target: { ref: "self" } }],
        },
      ],
    },
    { type: "Response", effects: [eliminateOneAtSelf("Rebel")] },
  ],
  // Only ability 2 (the conditional-reveal one) is encoded — abilities 0
  // ("place 2 rebels, each at any location") and 1 ("draw 3 cards") are
  // separate, unstarted content work, not part of the conditionals feature.
  "Opposition Leader": [
    undefined,
    undefined,
    {
      type: "Activate",
      effects: [
        {
          verb: "reveal",
          bind: "target",
          target: {
            ref: "filter",
            location: { mode: "any" },
            blendState: "faceDown",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
        {
          verb: "if",
          condition: {
            op: "and",
            conditions: [
              { op: "equals", left: { source: "binding", binding: "target", field: "kind" }, value: "nonLeader" },
              { op: "equals", left: { source: "binding", binding: "target", field: "faction" }, value: "Rebel" },
            ],
          },
          then: [{ verb: "gainControl", target: { ref: "binding", binding: "target" } }],
        },
      ],
    },
  ],
  "Suicide Bomber": [
    {
      type: "Activate",
      alarm: true,
      effects: [
        {
          verb: "reveal",
          target: {
            ref: "filter",
            location: { mode: "self" },
            blendState: "faceDown",
            hasAttribute: "Protected",
            count: { mode: "all" },
            selection: "playerChoice",
          },
        },
        {
          verb: "eliminate",
          target: {
            ref: "filter",
            location: { mode: "self" },
            count: { mode: "exact", value: 4 },
            selection: "random",
            randomPool: { pool: "unprotected", fallbackPool: "protected" },
          },
        },
        {
          verb: "eliminate",
          target: { ref: "self" },
        },
      ],
    },
  ],
};

export function getAbilityEffects(defRef: string, abilityIndex: number): AbilityDefinition | undefined {
  return abilityEffects[defRef]?.[abilityIndex];
}
