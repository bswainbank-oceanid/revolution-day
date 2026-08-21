import type { BoardLayout } from "./board";
import type { CardInstance } from "./cards";
import type { RngState } from "./rng";

export type PlayerId = string;

export interface Player {
  readonly id: PlayerId;
  readonly seatIndex: number;
}

export interface PresidentState {
  readonly status: "notEntered" | "alive" | "eliminated" | "survived";
  // null while notEntered, eliminated, or survived (off the board).
  readonly locationId: string | null;
  // Set once, the moment the President is eliminated — backs the Wife's
  // "eliminated at the Palace" win condition without a history scan, since
  // it's a singular fact rather than a per-card attribution query.
  readonly eliminatedAtLocationId?: string;
}

export interface TurnState {
  readonly currentPlayerId: PlayerId;
  readonly phase: "draw" | "action";
  // Starts at 2 but is a mutable counter effects can increment (Heir
  // Apparent's "gain 2 actions"), not a fixed countdown.
  readonly actionsRemaining: number;
  // null until the President is eliminated, then counts down from 3.
  readonly endgameTurnsRemaining: number | null;
}

// Resolution-stack frame types (AbilityResolution, AlarmResolution,
// ProtectedTargetingWindow, MotorcadeInterceptionWindow) are not yet
// defined — see rev_day_engine_design memory for their specs. Placeholder
// until that's built out.
export type ResolutionFrame = unknown;

export interface GameState {
  readonly rng: RngState;
  readonly board: BoardLayout;
  readonly players: readonly Player[];
  readonly cards: readonly CardInstance[];
  readonly president: PresidentState;
  readonly turn: TurnState;
  readonly resolutionStack: readonly ResolutionFrame[];
}
