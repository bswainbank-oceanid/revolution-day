import type { PlayerId } from "./game";

// The four interrupt patterns from the engine design (see
// rev_day_engine_design memory), each a distinct resolution-stack frame
// shape rather than one generic "pending choice" type.

// A pending ability that hasn't (yet) chosen its targets/applied its
// effects. Alarm-triggering abilities push this *before* an
// AlarmResolutionFrame and only resume it (choosing targets) once the
// alarm's response window fully resolves.
export interface AbilityResolutionFrame {
  readonly kind: "abilityResolution";
  readonly sourceCardId: string;
  // Who is resolving/paying for this — may differ from the source card's
  // controller under remote-activation (Head of Security etc.).
  readonly actingPlayerId: PlayerId;
  readonly abilityIndex: number;
  readonly locationId: string;
  // null until targets have been chosen.
  readonly targetIds: readonly string[] | null;
}

// Walks seating order starting after the triggering (acting) player,
// wrapping around, triggering player last. Every player gets a turn — no
// skipping (contrast ProtectedTargetingWindowFrame below).
export interface AlarmResolutionFrame {
  readonly kind: "alarmResolution";
  readonly triggeringCardId: string;
  readonly triggeringPlayerId: PlayerId;
  readonly locationId: string;
  readonly order: readonly PlayerId[];
  readonly nextIndex: number;
}

// Opens when a declared target would be a Protected character. A single,
// non-repeating pass starting after the declaring player, skipping both
// the declarer and any player with no blended character at the location.
export interface ProtectedTargetingWindowFrame {
  readonly kind: "protectedTargetingWindow";
  readonly declaringPlayerId: PlayerId;
  readonly declaredTargetId: string;
  readonly locationId: string;
  readonly order: readonly PlayerId[];
  readonly nextIndex: number;
}

// Opens before a Motorcade's move effect applies. Offered only to eligible
// interceptors (Throng of Admirers / Angry Mob controllers at the
// President's pre-move location), in table order starting after the
// acting player. First "yes" wins and stops the pass immediately.
export interface MotorcadeInterceptionWindowFrame {
  readonly kind: "motorcadeInterceptionWindow";
  readonly actingPlayerId: PlayerId;
  readonly presidentLocationId: string;
  readonly order: readonly PlayerId[];
  readonly nextIndex: number;
}

export type ResolutionFrame =
  | AbilityResolutionFrame
  | AlarmResolutionFrame
  | ProtectedTargetingWindowFrame
  | MotorcadeInterceptionWindowFrame;

// The post-action FIFO passive queue (Celebrity, Martyr) is deliberately
// *not* a stack frame — it queues during resolution but only drains after
// the entire top-level action (including any alarm sub-resolution)
// completes, the opposite timing from alarms. Lives alongside the stack in
// GameState, not on it.
export interface PendingPassiveTrigger {
  readonly event: "eliminated";
  readonly cardId: string;
  readonly scope: "controller" | "allPlayers";
}
