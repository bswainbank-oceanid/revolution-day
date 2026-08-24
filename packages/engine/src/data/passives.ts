import type { PassiveDefinition } from "../effects/passives";

// Maps a card's defRef to its structured passive — see
// effects/passives.ts and the card_data.json `passive` text each of these
// was derived from. Every card with a `passive` field is covered; a card
// with no entry here simply has no passive.
export const passives: Readonly<Record<string, PassiveDefinition>> = {
  Bodyguard: { kind: "followPresident" },
  "Throng of Admirers": { kind: "motorcadeInterception" },
  "Angry Mob": { kind: "motorcadeInterception" },
  Celebrity: { kind: "reactiveOnElimination", scope: "allPlayers" },
  Martyr: { kind: "reactiveOnElimination", scope: "controller", playFaction: "Rebel" },
  "Mr. Lucky": { kind: "replacementOnElimination", effect: "returnToHand" },
};

export function getPassive(defRef: string): PassiveDefinition | undefined {
  return passives[defRef];
}
