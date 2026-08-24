import type { WinPredicate } from "../effects/winConditions";

// Maps a leader's defRef to its win_conditions list, OR'd — see
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
    { type: "eliminatedByControlled", target: "president" },
    { type: "eliminatedByControlled", target: { leaderCount: 2 } },
    { type: "survives" },
  ],
  "Puppet-Master": [{ type: "metaNoOtherPlayerWins" }, { type: "survives" }],
};
