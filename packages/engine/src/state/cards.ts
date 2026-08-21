// Card instances unify leaders and non-leader cards into one lifecycle:
// deck -> hand -> inPlay -> (eliminated | discard). Leaders are dealt into
// hand at setup rather than drawn, but otherwise follow the same lifecycle
// as any other character card. Only `controller` is tracked (no separate
// `owner`) — every ability that returns a card returns it to the *current*
// controller's hand, never an original owner.
export type Zone = "deck" | "hand" | "inPlay" | "eliminated" | "discard";
export type CardKind = "leader" | "nonLeader" | "motorcade";

export interface CardInstance {
  readonly id: string;
  // Key into the static leaders/non_leader_cards table by name, or
  // "Motorcade" for motorcade instances.
  readonly defRef: string;
  readonly kind: CardKind;
  readonly zone: Zone;
  // null only while sitting in the shared deck.
  readonly controller: string | null;
  // Set iff zone === "inPlay".
  readonly locationId?: string;
  // Blend state; meaningful only while zone === "inPlay".
  readonly faceUp?: boolean;
}
