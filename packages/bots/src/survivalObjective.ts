import { asCardInstance, hasAttribute, knownFaction } from "@rev-day/engine";
import type { CardData, Faction, FilteredGameState, PlayerId, WinPredicate } from "@rev-day/engine";

// "survives" is checked as `leader.zone === "inPlay"` at game end
// (winConditions.ts) — a Protected leader who's never left hand doesn't
// satisfy it, and a Protected leader wandering around unescorted is easy
// prey (findProtectorCards: a Protected card is shielded only by other
// active, visible, same-faction, non-Protected cards at its own
// location). So "needs an escort" is exactly: Protected, and a `survives`
// predicate in the leader's own win conditions. Master Assassin has
// `survives` too but no Protected attribute — his safety comes from
// staying hidden (Blend), not from an escort, so he correctly reads as
// not needing one here. Data-driven like presidentObjectiveFor/
// leaderLocationObjectiveFor — no hardcoded leader list, and doesn't
// recurse into `{type:"or"}` wrappers since no current leader nests
// "survives" inside one.
export function leaderNeedsEscort(
  cardData: CardData,
  winConditions: Readonly<Record<string, readonly WinPredicate[]>>,
  leaderDefRef: string,
): boolean {
  const predicates = winConditions[leaderDefRef] ?? [];
  if (!predicates.some((p) => p.type === "survives")) return false;
  const def = cardData.leaders.find((l) => l.name === leaderDefRef);
  return def?.attributes.includes("Protected") ?? false;
}

// Whether `locationId` currently has an active escort for `faction`,
// specifically controlled by `playerId` — a real, same-faction,
// non-Protected (a Protected character doesn't shield another Protected
// one), visible (not hidden Blend) card. Deliberately narrower than the
// engine's own findProtectorCards, which also counts a suitable card
// controlled by any OTHER player: relying on someone else's card is
// nothing this player can plan around or keep in place, so a bot heuristic
// only trusts protection it can itself provide and move. `excludeCardId`
// lets a caller check "would this location still be escorted without
// card X" (e.g. the leader's own card, which obviously can't escort
// itself).
export function isEscortedLocation(
  state: FilteredGameState,
  cardData: CardData,
  playerId: PlayerId,
  faction: Faction,
  locationId: string,
  excludeCardId?: string,
): boolean {
  return state.cards.some((c) => {
    if (c.id === excludeCardId) return false;
    if (c.zone !== "inPlay" || c.controller !== playerId || c.locationId !== locationId) return false;
    if (knownFaction(cardData, c) !== faction) return false;
    const instance = asCardInstance(c);
    if (!instance) return false;
    if (hasAttribute(cardData, instance, "Protected")) return false;
    return !hasAttribute(cardData, instance, "Blend") || c.faceUp === true;
  });
}
