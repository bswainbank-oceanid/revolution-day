import type { BoardLayout } from "./board";
import type { CardInstance } from "./cards";
import type { PendingPassiveTrigger, ResolutionFrame } from "./resolution";
import type { RngState } from "./rng";

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
  // Extra actions that can ONLY pay for playCard/playMotorcade (Puppet-
  // Master's "Play 2 cards", encoded as gainActions with restriction:
  // "play") — a separate pool from actionsRemaining so it can't be spent
  // on draw/move/activateAbility. Spent before actionsRemaining (see
  // spendPlayAction) since it's otherwise wasted at end of turn; reset to
  // 0 every turn, same as actionsRemaining itself.
  readonly restrictedPlayActions: number;
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
