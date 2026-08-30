import type { BoardLayout } from "./board";
import type { CardInstance } from "./cards";
import type { PendingPassiveTrigger, ResolutionFrame } from "./resolution";
import type { RngState } from "./rng";
import type { Faction } from "../types";

// A single, currently-active repeatable-action grant — Puppet-Master's
// "Play 2 cards", Master Assassin's "return and play a card", Commander
// General's "any number... at this location" (both play and activate
// variants), Opposition Leader's "place 2 rebels at any locations". Every
// ability that grants one belongs to a single player's own leader, so at
// most one is ever active for a given player at a time — a fresh grant
// replaces whatever was there, never stacks.
export interface RestrictedActionGrant {
  // Which top-level action type this can pay for — playCard/playMotorcade
  // for "play", activateAbility for "activate". Never draw/moveCard/
  // anything else.
  readonly kind: "play" | "activate";
  // "unbounded" for "any number" (Commander General) — never depletes;
  // a numeric amount decrements per use and the grant is cleared once it
  // hits 0.
  readonly amount: number | "unbounded";
  // Restricts which cards this grant can pay for — null means any.
  readonly faction: Faction | null;
  // Forces every use of this grant to one specific location (the
  // granting card's own, e.g. Commander General's "at this location") —
  // null means the player chooses freely (Puppet-Master, Master
  // Assassin, Opposition Leader's "at any locations").
  readonly locationId: string | null;
  // "play" only: whether the card's own printed allowed-location-types
  // are bypassed when using this grant.
  readonly ignoreLocationRestrictions: boolean;
}

export type PlayerId = string;

export interface Player {
  readonly id: PlayerId;
  readonly seatIndex: number;
  // True once this player's turn has ended at least once — backs the
  // Motorcade restriction "cannot be played on a player's first turn".
  readonly hasTakenFirstTurn: boolean;
}

export interface PresidentState {
  readonly status: "notEntered" | "alive" | "eliminated" | "survived";
  // null while notEntered, eliminated, or survived (off the board).
  readonly locationId: string | null;
  // Set once, the moment the President is eliminated — backs the Wife's
  // "eliminated at the Palace" win condition without a history scan, since
  // it's a singular fact rather than a per-card attribution query.
  readonly eliminatedAtLocationId?: string;
  // Set once, the moment the President is eliminated: whoever controlled
  // the eliminating card at that moment — see CardInstance.eliminatedByPlayerId.
  readonly eliminatedByPlayerId?: PlayerId;
}

export interface TurnState {
  readonly currentPlayerId: PlayerId;
  readonly phase: "draw" | "action";
  // Starts at 2 but is a mutable counter effects can increment (Heir
  // Apparent's "gain 2 actions"), not a fixed countdown.
  readonly actionsRemaining: number;
  // See RestrictedActionGrant's own doc comment — spent before
  // actionsRemaining (preferred whenever it applies, since it's
  // otherwise wasted at end of turn); reset to null every turn, same as
  // actionsRemaining resets to its own fresh value.
  readonly restrictedAction: RestrictedActionGrant | null;
  // null until the President is eliminated, then counts down from 3.
  readonly endgameTurnsRemaining: number | null;
  // "cardId#abilityIndex" keys — backs "each Activate ability can only be
  // used once each turn". Reset every time a turn ends.
  readonly usedAbilities: readonly string[];
}

export interface GameState {
  readonly rng: RngState;
  readonly board: BoardLayout;
  readonly players: readonly Player[];
  readonly cards: readonly CardInstance[];
  readonly president: PresidentState;
  readonly turn: TurnState;
  readonly resolutionStack: readonly ResolutionFrame[];
  // FIFO, not part of the stack — see resolution.ts.
  readonly pendingPassiveQueue: readonly PendingPassiveTrigger[];
}
