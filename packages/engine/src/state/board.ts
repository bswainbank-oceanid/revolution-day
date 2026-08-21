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
  return cardData.locations_in_order.map((typeName, index) => {
    const type = cardData.location_types[typeName];
    if (!type) {
      throw new Error(`Unknown location type in locations_in_order: ${typeName}`);
    }
    return { id: `loc-${index}`, type };
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
