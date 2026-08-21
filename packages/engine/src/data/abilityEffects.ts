import type { AbilityDefinition } from "../effects/dsl";

// Maps a card's defRef to its Activate/Response abilities' structured
// effects, in the same order as card_data.json's `abilities` array for
// that card. Only a handful of the simplest (non-alarm, single-target)
// abilities are encoded so far, to prove the interpreter pipeline end to
// end — activateAbility throws a clear "not yet encoded" error for
// anything else rather than pretending full content coverage exists. The
// remaining ~25 cards are unstarted content work, not a design gap (see
// rev_day_engine_design memory).
export const abilityEffects: Record<string, readonly AbilityDefinition[]> = {
  "Republican Guard": [
    {
      type: "Activate",
      effects: [
        {
          verb: "eliminate",
          target: {
            ref: "filter",
            location: { mode: "self" },
            count: { mode: "exact", value: 1 },
            selection: "playerChoice",
          },
        },
      ],
    },
  ],
  Assassin: [
    {
      type: "Activate",
      effects: [
        {
          verb: "eliminate",
          target: {
            ref: "filter",
            location: { mode: "self" },
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
