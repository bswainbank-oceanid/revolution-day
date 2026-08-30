import type { AbilityDefinition } from "../effects/dsl";

// Maps a card's defRef to its Activate/Response abilities' structured
// effects, in the same order as card_data.json's `abilities` array for
// that card. Every card with a real ability now has one encoded — a card
// absent from this map simply has no ability at all (a passive-only card
// like Celebrity or Mr. Lucky); activateAbility/useResponse throw a clear
// "not yet encoded" error rather than pretending coverage exists where it
// doesn't, for whenever a future card set introduces something new. See
// rev_day_engine_design memory for the DSL design and any remaining
// known gaps.
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

const eliminateExactlyAtSelf = (count: number, faction?: "Regime" | "Rebel") =>
  ({
    verb: "eliminate" as const,
    target: {
      ref: "filter" as const,
      location: { mode: "self" as const },
      count: { mode: "exact" as const, value: count },
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
            location: { mode: "self" },
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
      ],
    },
  ],
  "Head of Security": [
    { type: "Activate", effects: [activateRemoteNonLeader("Regime")] },
    { type: "Response", effects: [eliminateOneAtSelf()] },
  ],
  "Heir Apparent": [
    { type: "Activate", effects: [{ verb: "gainActions", amount: 2 }] },
    { type: "Activate", alarm: true, effects: [eliminateOneOrTwoAtSelf()] },
    { type: "Response", effects: [eliminateOneOrTwoAtSelf()] },
  ],
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
  "Puppet-Master": [
    // "Play 2 cards" — granted as two restricted actions (spendable only
    // on playCard/playMotorcade — see TurnState.restrictedPlayActions)
    // rather than a single "choose 2 hand cards" declaration: each card
    // is played individually through the normal turn-action flow, at its
    // own normal allowed location, the same as any other play — which is
    // also what makes Motorcades playable here at all (playMotorcade is a
    // distinct top-level action, not something a `play` effect's
    // chooseTargets step could ever invoke).
    {
      type: "Activate",
      effects: [{ verb: "gainActions", amount: 2, restriction: "play" }],
    },
    { type: "Activate", effects: [activateRemoteNonLeader()] },
  ],
  "Death Squad": [
    { type: "Activate", alarm: true, effects: [eliminateOneOrTwoAtSelf()] },
    { type: "Response", effects: [eliminateOneOrTwoAtSelf()] },
  ],
  "Master Assassin": [
    // "Return this card to its controller's hand and play a card" —
    // granted as a single restricted action (spendable only on
    // playCard/playMotorcade — see TurnState.restrictedPlayActions), same
    // redesign as Puppet-Master's "Play 2 cards": the played card goes
    // through the normal turn-action flow at its own normal location
    // (not forced to Master Assassin's former location, which is
    // undefined anyway right after returnToHand clears it), and Motorcades
    // become playable here too, unlike the old single chooseTargets
    // declaration.
    {
      type: "Activate",
      effects: [
        { verb: "returnToHand", target: { ref: "self" } },
        { verb: "gainActions", amount: 1, restriction: "play" },
      ],
    },
    // "Eliminate a target and blend" — blends itself back down after
    // eliminating (not the target — an eliminated card has no faceUp).
    {
      type: "Activate",
      effects: [eliminateOneAtSelf(), { verb: "blend", target: { ref: "self" } }],
    },
    { type: "Activate", alarm: true, effects: [eliminateExactlyAtSelf(2)] },
    { type: "Response", effects: [eliminateOneAtSelf()] },
  ],
  "Commander General": [
    // "Play any number of regime cards at this location" — same
    // restricted-action template as Puppet-Master/Master Assassin (an
    // unbounded grant instead of a single simultaneous chooseTargets
    // declaration), but unlike those two, the card text keeps its own
    // faction restriction and "at THIS location" qualifier, so the grant
    // carries both: faction:"Regime" and location:"self" (forced to
    // Commander General's own location, not the player's free choice).
    {
      type: "Activate",
      effects: [
        { verb: "gainActions", amount: "unbounded", restriction: "play", faction: "Regime", location: "self", ignoreLocationRestrictions: true },
      ],
    },
    // "Activate any number of your regime cards at this location" — the
    // same template again, but restriction:"activate" instead of "play":
    // each activation goes through the normal activateAbility action
    // (already restricted to the player's own cards, matching this
    // ability's controller:"self"), not a recursive activateRemote loop.
    {
      type: "Activate",
      effects: [{ verb: "gainActions", amount: "unbounded", restriction: "activate", faction: "Regime", location: "self" }],
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
  "Opposition Leader": [
    // "Place 2 rebels at any locations (ignore location restrictions)" —
    // same restricted-action template as Puppet-Master/Master Assassin: a
    // grant of 2 (not unbounded — this ability is explicitly capped),
    // faction:"Rebel" (its own restriction, unlike Puppet-Master/Master
    // Assassin which have none), ignoreLocationRestrictions:true, and no
    // forced location — "any locations" already means the player's free
    // per-card choice, exactly what the redesigned playCard flow gives
    // for free, without needing the old chooseTargets.locationIds pairing.
    {
      type: "Activate",
      effects: [{ verb: "gainActions", amount: 2, restriction: "play", faction: "Rebel", ignoreLocationRestrictions: true }],
    },
    { type: "Activate", effects: [{ verb: "draw", amount: 3 }] },
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
  "Traffic Cop": [
    {
      type: "Activate",
      effects: [
        {
          verb: "move",
          target: {
            ref: "filter",
            kind: "president",
            location: { mode: "self" },
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
          destination: { mode: "forwardOrBackward", amount: 1 },
        },
      ],
    },
  ],
  "Army Sniper": [
    {
      type: "Activate",
      alarm: true,
      effects: [
        {
          verb: "eliminate",
          target: {
            ref: "filter",
            location: { mode: "selfOrAdjacent" },
            faction: "Rebel",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
      ],
    },
    { type: "Response", effects: [eliminateOneAtSelf()] },
  ],
  "Rebel Soldier": [{ type: "Activate", alarm: true, effects: [eliminateOneOrTwoAtSelf("Regime")] }],
  // Deliberately encoded as an effect verb rather than the ability-level
  // `alarm: true` flag both cards carry in card_data.json — that flag's
  // mechanism (applyActivateAbility) always fires the alarm at the
  // activating card's *own* location, which can't express Anarchist's
  // "any location" choice at all. Using the same triggerAlarm effect for
  // both keeps their near-identical ability text encoded in parallel
  // rather than an arbitrary asymmetry (Angry Mob genuinely could have
  // used the flag, since self-location happens to match; Anarchist
  // structurally can't). See applyTriggerAlarmEffect in reducer.ts —
  // AbilityDefinition.alarm (not the raw card_data.json flag) is what
  // actually drives the pre-effect alarm-frame push, so simply omitting
  // it here is enough; no card_data.json edit needed.
  "Angry Mob": [{ type: "Activate", effects: [{ verb: "triggerAlarm", location: { mode: "self" } }] }],
  Journalist: [
    {
      type: "Activate",
      effects: [
        {
          verb: "peek",
          target: {
            ref: "filter",
            location: { mode: "self" },
            blendState: "faceDown",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
      ],
    },
  ],
  "Insurgent Sniper": [
    {
      type: "Activate",
      alarm: true,
      effects: [
        {
          verb: "eliminate",
          target: {
            ref: "filter",
            location: { mode: "adjacent" },
            faction: "Regime",
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
      ],
    },
  ],
  Anarchist: [{ type: "Activate", effects: [{ verb: "triggerAlarm", location: { mode: "any" } }] }],
};

export function getAbilityEffects(defRef: string, abilityIndex: number): AbilityDefinition | undefined {
  return abilityEffects[defRef]?.[abilityIndex];
}
