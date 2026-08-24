import type { Faction } from "../types";
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
  // Which of the ability's effects (AbilityDefinition.effects) is
  // currently pending — undefined means 0. Most abilities have exactly
  // one effect, so this stays unset; a sequence (Suicide Bomber: forced
  // reveal, then random eliminate, then eliminate self) advances it one
  // step at a time as each effect finishes, reusing this same frame
  // rather than a separate "sequence" concept. No conditionals/bindings —
  // just an ordered walk; see rev_day_engine_design memory.
  readonly effectIndex?: number;
  // null until targets have been chosen for the *current* effect.
  readonly targetIds: readonly string[] | null;
  // Named cards captured by an earlier `reveal`/`peek` step's `bind` field
  // (binding name -> card id), read back by a later `if` condition or a
  // `ref: "binding"` target in the same ability — Secret Police's "Reveal a
  // blended target. If it is a rebel, eliminate it." pattern. Accumulates
  // as the sequence advances; never cleared mid-ability.
  readonly bindings?: Readonly<Record<string, string>>;
  // True once a protected-targeting reveal window has completed with at
  // least one reveal, and control has returned here for the acting player
  // to freely re-choose (Protected and still-blended characters included)
  // — that re-choice is final and never re-opens the window, even if it's
  // Protected again.
  readonly reselectingAfterReveal?: boolean;
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
// If *anyone* reveals *anything* during the pass (regardless of whether it
// would actually have protected the original target), control returns to
// the declaring player to freely re-choose afterward — see
// AbilityResolutionFrame.reselectingAfterReveal — rather than the target
// being automatically reassigned.
export interface ProtectedTargetingWindowFrame {
  readonly kind: "protectedTargetingWindow";
  readonly declaringPlayerId: PlayerId;
  // Usually one target, but a multi-target eliminate (Death Squad's "one
  // or two targets") declares its whole batch together — the window
  // covers the shared location, not any single target within it.
  readonly declaredTargetIds: readonly string[];
  readonly locationId: string;
  readonly order: readonly PlayerId[];
  readonly nextIndex: number;
  readonly anyRevealed: boolean;
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

// Opens once a queued PendingPassiveTrigger (see below) is actually
// activated — Celebrity ("all players can immediately play any number of
// cards at this location") or Martyr ("its controller can immediately play
// any number of rebel cards..."). `order` is either every player (Celebrity,
// table order starting after whoever controlled the eliminating card) or
// just the eliminated card's controller alone (Martyr) — see
// data/passives.ts. `locationId`/`faction` are captured from the trigger,
// since the eliminated source card itself no longer has a locationId by the
// time this opens.
export interface ReactivePassiveWindowFrame {
  readonly kind: "reactivePassiveWindow";
  readonly sourceCardId: string;
  readonly locationId: string;
  readonly faction?: Faction;
  readonly order: readonly PlayerId[];
  readonly nextIndex: number;
}

export type ResolutionFrame =
  | AbilityResolutionFrame
  | AlarmResolutionFrame
  | ProtectedTargetingWindowFrame
  | MotorcadeInterceptionWindowFrame
  | ReactivePassiveWindowFrame;

// The post-action FIFO passive queue (Celebrity, Martyr) is deliberately
// *not* a stack frame — it queues during resolution but only drains after
// the entire top-level action (including any alarm sub-resolution)
// completes, the opposite timing from alarms. Lives alongside the stack in
// GameState, not on it. Each entry is activated (turned into a
// ReactivePassiveWindowFrame) one at a time, only once the stack is fully
// empty again — see drainPendingPassives in reducer.ts.
export interface PendingPassiveTrigger {
  readonly event: "eliminated";
  readonly cardId: string;
  // Captured at elimination time, since the card's own locationId is
  // cleared once it's actually gone.
  readonly locationId: string;
  readonly scope: "controller" | "allPlayers";
  readonly faction?: Faction;
  // Whoever controlled the *eliminating* card — anchors table order for
  // an "allPlayers" window the same way other windows start after the
  // acting player.
  readonly triggeredByPlayerId: PlayerId;
  readonly controllerPlayerId: PlayerId;
}
