import type { FilteredGameState, PlayerId } from "@rev-day/engine";

// Whose decision is it right now? NOT always turn.currentPlayerId — a
// resolution-stack frame (an ability being targeted, an alarm response
// pass, a reveal/interception/reactive window) can hand the decision to a
// different player mid-turn. Ported directly from this project's own
// /tmp/drive_bots.py smoke-test driver, proven correct against many live
// games this session: abilityResolution names its actingPlayerId
// directly; every other frame kind shares the same order/nextIndex shape.
export function decider(state: FilteredGameState): PlayerId {
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  if (!frame) return state.turn.currentPlayerId;
  if (frame.kind === "abilityResolution") return frame.actingPlayerId;
  return frame.order[frame.nextIndex]!;
}
