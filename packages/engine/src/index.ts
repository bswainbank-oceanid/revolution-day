export { cardData } from "./data/cardData";
export type {
  CardData,
  LeaderCard,
  NonLeaderCard,
  PresidentData,
  MotorcadeData,
  Ability,
  Faction,
  LocationType,
  Attribute,
} from "./types";

import { cardData } from "./data/cardData";

/**
 * Placeholder entry point proving the engine package loads and types its
 * data correctly. Replace/extend once the state model, action interface,
 * and resolution stack are designed.
 */
export function getEngineInfo() {
  return {
    game: cardData.game,
    leaderCount: cardData.leaders.length,
    nonLeaderCount: cardData.non_leader_cards.length,
    locations: cardData.locations_in_order,
  };
}
