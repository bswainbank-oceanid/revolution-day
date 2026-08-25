import type { WinPredicate } from "../effects/winConditions";

// Maps a leader's defRef to its win_conditions list, AND'd — every
// sentence in the leader's card_data.json win_conditions text is a
// separate, simultaneously-required condition (corrected 2026-08-24, see
// rev_day_engine_design memory: this was originally built OR'd, which was
// wrong — Head of Security genuinely needs to survive *and* the President
// not be eliminated, not either alone). Guerrilla Commander has no
// "Survive." sentence at all, so it genuinely doesn't need to survive —
// its three listed conditions still all AND together. Master Assassin's
// first sentence has an explicit "or" inside it ("eliminate the President
// or 2 leaders"), so that part is wrapped in `{type: "or"}` to keep it a
// real OR while "Survive." stays a separate AND'd requirement. See
// evaluateWinConditions in effects/winConditions.ts and the "Win-condition
// predicate DSL" section of rev_day_engine_design memory for the full
// derivation from each leader's card_data.json text.
export const winConditions: Readonly<Record<string, readonly WinPredicate[]>> = {
  "Head of Security": [{ type: "presidentStatus", value: "notEliminated" }, { type: "survives" }],
  "Commander General": [
    { type: "presidentStatus", value: "eliminated" },
    { type: "survives" },
    { type: "factionMajority", locationName: "HQ", faction: "Regime" },
  ],
  Wife: [{ type: "presidentEliminatedAt", locationName: "Palace" }],
  "Heir Apparent": [{ type: "survives" }, { type: "noOtherSurvivingLeaders" }],
  "Opposition Leader": [
    { type: "survives" },
    { type: "locationSpread", faction: "Rebel", minLocations: 5 },
  ],
  "Guerrilla Commander": [
    { type: "presidentStatus", value: "eliminated" },
    { type: "metaNoFactionLeaderWins", faction: "Regime" },
    { type: "factionMajority", locationName: "Palace", faction: "Rebel" },
  ],
  "Master Assassin": [
    {
      type: "or",
      predicates: [
        { type: "eliminatedByControlled", target: "president" },
        { type: "eliminatedByControlled", target: { leaderCount: 2 } },
      ],
    },
    { type: "survives" },
  ],
  "Puppet-Master": [{ type: "metaNoOtherPlayerWins" }, { type: "survives" }],
};
