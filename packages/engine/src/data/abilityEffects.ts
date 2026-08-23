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

export const abilityEffects: Record<string, readonly AbilityDefinition[]> = {
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
};

export function getAbilityEffects(defRef: string, abilityIndex: number): AbilityDefinition | undefined {
  return abilityEffects[defRef]?.[abilityIndex];
}
