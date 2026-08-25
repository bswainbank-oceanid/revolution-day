import { applyAction, filterForPlayer } from "@rev-day/engine";
import type { Action, CardData, GameState, PlayerId } from "@rev-day/engine";
import { decideBotAction } from "./decide";
import type { Rng } from "./random";

// Bounded so a truly pathological state can't spin forever — well above
// what any real turn should ever need (a multi-step ability sequence plus
// a couple of alarm passes is still well under this).
const MAX_ATTEMPTS_PER_DECISION = 20;
const MAX_DECISIONS_PER_TURN = 100;

export interface BotTurnStep {
  readonly actingPlayerId: PlayerId;
  readonly action: Action;
  readonly resultingState: GameState;
}

export interface BotTurnResult {
  readonly state: GameState;
  // Every action actually applied, in order, each paired with the state
  // it produced — the full "state, action, resulting state" trajectory
  // shape the locked persistence design calls for (see
  // rev_day_architecture memory), so a caller (the server harness) can
  // log each step individually instead of collapsing a whole turn into
  // one opaque entry.
  readonly actions: readonly BotTurnStep[];
}

// Drives one bot's turn to completion: decide → applyAction (the real
// engine, real legality) → check whose decision is next → repeat, until
// control genuinely passes to someone else (another player must respond
// to an alarm the bot triggered, it's simply no longer this player's
// turn, etc.) or the bot ends its own turn. decideBotAction only ever
// sees a filterForPlayer view — this is the one place that touches real
// GameState and the real applyAction, since validating "was that guess
// actually legal" doesn't leak anything the bot didn't already choose
// without using hidden information.
export function takeBotTurn(state: GameState, playerId: PlayerId, cardData: CardData, rng: Rng = Math.random): BotTurnResult {
  let current = state;
  const actions: BotTurnStep[] = [];
  for (let step = 0; step < MAX_DECISIONS_PER_TURN; step++) {
    if (currentDeciderId(current) !== playerId) break;
    const next = takeOneDecision(current, playerId, cardData, rng);
    if (next.state === current) break; // genuinely stuck — see takeOneDecision
    current = next.state;
    if (next.action) actions.push({ actingPlayerId: playerId, action: next.action, resultingState: current });
  }
  return { state: current, actions };
}

// One decision point: generate-and-check candidates from decideBotAction
// (fresh randomness each attempt, so a retry can land somewhere new) up
// to a bound, then fall back to the always-safe decline/end action for
// the current context. If even that fails (pathological — genuinely
// nothing legal at all), returns `state` unchanged (and no action) so the
// caller's reference check can detect it's stuck rather than looping
// forever.
function takeOneDecision(
  state: GameState,
  playerId: PlayerId,
  cardData: CardData,
  rng: Rng,
): { state: GameState; action?: Action } {
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_DECISION; attempt++) {
    const filtered = filterForPlayer(state, playerId);
    const action = decideBotAction(filtered, playerId, cardData, rng);
    try {
      return { state: applyAction(state, playerId, action, cardData), action };
    } catch {
      // Try again with a fresh random candidate.
    }
  }
  const fallback = fallbackAction(state);
  try {
    return { state: applyAction(state, playerId, fallback, cardData), action: fallback };
  } catch {
    return { state };
  }
}

// Not always legal for an abilityResolution frame (some effects
// genuinely require a valid target with no "decline" option) — but it's
// the best generic guess, and by this point MAX_ATTEMPTS_PER_DECISION
// real random attempts have already failed regardless.
function fallbackAction(state: GameState): Action {
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  if (!frame) {
    return state.turn.phase === "draw" ? { type: "draw" } : { type: "endTurn" };
  }
  switch (frame.kind) {
    case "abilityResolution":
      return { type: "chooseTargets", targetIds: [] };
    case "alarmResolution":
      return { type: "passResponse" };
    case "protectedTargetingWindow":
      return { type: "passReveal" };
    case "motorcadeInterceptionWindow":
      return { type: "passIntercept" };
    case "reactivePassiveWindow":
      return { type: "passReactive" };
  }
}

function currentDeciderId(state: GameState): PlayerId {
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  if (!frame) return state.turn.currentPlayerId;
  switch (frame.kind) {
    case "abilityResolution":
      return frame.actingPlayerId;
    case "alarmResolution":
    case "protectedTargetingWindow":
    case "motorcadeInterceptionWindow":
    case "reactivePassiveWindow":
      return frame.order[frame.nextIndex]!;
  }
}
