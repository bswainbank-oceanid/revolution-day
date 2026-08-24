import type { CardData, LocationType } from "../types";

// Board layout is data-driven (not a hardcoded constant) so future variants
// can use different location sets — see rev_day_engine_design memory.
export interface LocationInstance {
  readonly id: string;
  readonly type: LocationType;
  readonly name?: string;
}

export type BoardLayout = readonly LocationInstance[];

export function boardLayoutFromCardData(cardData: CardData): BoardLayout {
  // `locations_in_order` holds each position's *name* (some generic and
  // repeated, like "Street"; some unique, like "HQ"/"Arena"/"Palace"),
  // which `location_types` maps to a LocationType. Both need to survive
  // onto the LocationInstance — `type` for the existing card-placement
  // rules, `name` so a specific named location (HQ, Palace) can be found
  // by win-condition predicates, which a shared `type` can't distinguish
  // (HQ and Palace are both type "Secure").
  return cardData.locations_in_order.map((name, index) => {
    const type = cardData.location_types[name];
    if (!type) {
      throw new Error(`Unknown location type in locations_in_order: ${name}`);
    }
    return { id: `loc-${index}`, type, name };
  });
}

// Adjacency is pure index math — every rule referencing "adjacent" or
// "forward/backward" describes a line, not a graph.
export function adjacentLocationIds(board: BoardLayout, locationId: string): string[] {
  const index = board.findIndex((loc) => loc.id === locationId);
  if (index === -1) return [];
  const result: string[] = [];
  if (index > 0) result.push(board[index - 1]!.id);
  if (index < board.length - 1) result.push(board[index + 1]!.id);
  return result;
}
