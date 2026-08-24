import type { Faction } from "../types";

// Declarative passive DSL — same spirit as effects/dsl.ts (abilities) and
// effects/winConditions.ts (win predicates), translating each card's
// free-text `passive` field into structured data (see data/passives.ts)
// instead of hardcoded per-card checks. Four distinct mechanism shapes,
// per the rev_day_engine_design memory's "passives split into (at least)
// three different mechanisms" analysis, plus the interception window
// (designed and built separately, before this DSL existed):
export type PassiveDefinition =
  // Replacement: intercepts an event and swaps it for something else
  // entirely before it ever takes effect — mandatory, no player choice.
  // Mr. Lucky: "if would be eliminated, return to hand instead."
  | { readonly kind: "replacementOnElimination"; readonly effect: "returnToHand" }
  // Reactive: fires *after* the event, queued to the post-action FIFO
  // queue (PendingPassiveTrigger) rather than applied immediately — see
  // drainPendingPassives in reducer.ts. Celebrity/Martyr's "if eliminated,
  // [scope] may immediately play any number of [faction] cards here
  // (ignore location restrictions)."
  | {
      readonly kind: "reactiveOnElimination";
      readonly scope: "controller" | "allPlayers";
      readonly playFaction?: Faction;
    }
  // Unconditional, immediate, not deferred to any queue or window —
  // Bodyguard's "if the President moves from this location, move this
  // card to the same location."
  | { readonly kind: "followPresident" }
  // Optional interception window before a *different*, still-pending
  // effect (Motorcade's move) applies — Throng of Admirers/Angry Mob.
  | { readonly kind: "motorcadeInterception" };
