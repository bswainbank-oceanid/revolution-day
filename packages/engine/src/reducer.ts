import type { Action } from "./actions";
import { getAbilityEffects } from "./data/abilityEffects";
import type { EffectNode, TargetCount } from "./effects/dsl";
import {
  hasRevealOpportunity,
  isLegalEliminationTarget,
  isLegalPresidentTarget,
  isProtectedActive,
  resolveEligibleTargets,
} from "./effects/targeting";
import { adjacentLocationIds } from "./state/board";
import { getAbilities, getAllowedLocationTypes, hasAttribute } from "./state/cardLookup";
import type { CardInstance } from "./state/cards";
import type { GameState, PlayerId } from "./state/game";
import type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  ProtectedTargetingWindowFrame,
  ResolutionFrame,
} from "./state/resolution";
import type { CardData } from "./types";

// The reducer: (state, action) -> newState. Pure — no I/O, no hidden
// randomness (the RNG lives in and is advanced through GameState itself).
// cardData is passed explicitly (not imported as a singleton) so a future
// variant's card set works unmodified, same as setupGame. "draw", "endTurn",
// "moveCard", "playCard", "playMotorcade", "activateAbility"/"chooseTargets"
// (including alarm-triggering abilities now), and "useResponse"/
// "passResponse" for the alarm-response window are implemented; everything
// else is an explicit "not yet implemented".
//
// playMotorcade is deliberately incomplete in two ways, both noted inline:
// it doesn't yet check for a Throng of Admirers/Angry Mob interception
// (needs the Motorcade interception window, a different frame kind with
// no dispatch logic yet), and it doesn't implement the forced "must play
// immediately" trigger on an empty deck (same gap already noted in
// applyDraw). activateAbility/chooseTargets/useResponse handle
// single-effect, single-target (`count.mode === "exact"`) `eliminate`
// abilities and single-card `activateRemote` (count 1 only — Commander
// General's "any number" variant isn't implemented) that have been
// encoded in abilityEffects.ts — no random targeting, no general
// multi-effect/conditional interpreter yet. See rev_day_engine_design
// memory for the full design this is incrementally building toward.
export function applyAction(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  if (state.resolutionStack.length > 0) {
    return applyResolutionAction(state, actingPlayerId, action, cardData);
  }

  if (actingPlayerId !== state.turn.currentPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn (current player is ${state.turn.currentPlayerId})`);
  }

  switch (action.type) {
    case "draw":
      return applyDraw(state);
    case "endTurn":
      return applyEndTurn(state);
    case "moveCard":
      return applyMoveCard(state, cardData, action);
    case "playCard":
      return applyPlayCard(state, cardData, action);
    case "playMotorcade":
      return applyPlayMotorcade(state, action);
    case "activateAbility":
      return applyActivateAbility(state, cardData, action);
    default:
      throw new Error(`Action not yet implemented: ${action.type}`);
  }
}

// Dispatches to whatever the top resolution-stack frame expects next.
// "abilityResolution" and "alarmResolution" are handled — the other two
// frame kinds (protected-targeting reveal, Motorcade interception) have no
// dispatch logic yet, since nothing can push them onto the stack yet
// either.
function applyResolutionAction(
  state: GameState,
  actingPlayerId: PlayerId,
  action: Action,
  cardData: CardData,
): GameState {
  const frame = state.resolutionStack[state.resolutionStack.length - 1]!;
  switch (frame.kind) {
    case "abilityResolution":
      if (action.type !== "chooseTargets") {
        throw new Error(`Expected chooseTargets while an ability awaits targets, got: ${action.type}`);
      }
      return applyChooseTargets(state, cardData, frame, actingPlayerId, action);
    case "alarmResolution":
      return applyAlarmAction(state, cardData, frame, actingPlayerId, action);
    case "protectedTargetingWindow":
      return applyProtectedTargetingWindowAction(state, frame, actingPlayerId, action);
    default:
      throw new Error(`Resolution frame not yet implemented: ${frame.kind}`);
  }
}

// Shared guard for the budgeted (non-mandatory-draw) actions: must be in
// the action phase with at least one action left.
function requireBudgetedAction(state: GameState): void {
  if (state.turn.phase !== "action") {
    throw new Error("Cannot take an action outside the action phase");
  }
  if (state.turn.actionsRemaining <= 0) {
    throw new Error("No actions remaining this turn");
  }
}

function spendAction(state: GameState): GameState["turn"] {
  return { ...state.turn, actionsRemaining: state.turn.actionsRemaining - 1 };
}

function applyDraw(state: GameState): GameState {
  const deckIndex = state.cards.findIndex((c) => c.zone === "deck");
  if (deckIndex === -1) {
    throw new Error("Cannot draw: deck is empty (forced Motorcade-play handling not yet implemented)");
  }

  const currentPlayerId = state.turn.currentPlayerId;
  const cards = state.cards.map((card, i) =>
    i === deckIndex ? { ...card, zone: "hand" as const, controller: currentPlayerId } : card,
  );

  if (state.turn.phase === "draw") {
    // The mandatory start-of-turn draw — not budgeted, transitions to the
    // action phase. Still a submitted action (not auto-applied inside
    // endTurn) so it stays a uniform, loggable decision point even though
    // there's no real choice involved.
    return { ...state, cards, turn: { ...state.turn, phase: "action" } };
  }

  // A voluntary "draw a card" during the action phase — one of the two
  // budgeted actions.
  requireBudgetedAction(state);
  return { ...state, cards, turn: spendAction(state) };
}

function applyEndTurn(state: GameState): GameState {
  if (state.turn.phase === "draw") {
    throw new Error("Cannot end turn before taking the mandatory draw");
  }

  const currentPlayerId = state.turn.currentPlayerId;
  const currentSeat = state.players.find((p) => p.id === currentPlayerId)!.seatIndex;
  const nextSeat = (currentSeat + 1) % state.players.length;
  const nextPlayerId = state.players.find((p) => p.seatIndex === nextSeat)!.id;
  const players = state.players.map((p) =>
    p.id === currentPlayerId ? { ...p, hasTakenFirstTurn: true } : p,
  );

  // Provisional: decrements once per completed turn, once non-null.
  // "Every player (including the current player) gets three more turns"
  // could mean per-round or per-individual-turn — nothing can set this
  // non-null yet (President elimination isn't implemented), so the exact
  // semantics aren't testable yet either. Revisit alongside that work.
  const endgameTurnsRemaining =
    state.turn.endgameTurnsRemaining === null ? null : Math.max(0, state.turn.endgameTurnsRemaining - 1);

  return {
    ...state,
    players,
    turn: {
      currentPlayerId: nextPlayerId,
      phase: "draw",
      actionsRemaining: 2,
      endgameTurnsRemaining,
      usedAbilities: [],
    },
  };
}

function applyMoveCard(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "moveCard" }>,
): GameState {
  requireBudgetedAction(state);

  const cardIndex = state.cards.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  const card = state.cards[cardIndex]!;

  if (card.zone !== "inPlay" || card.locationId === undefined) {
    throw new Error(`Card ${action.cardId} is not in play`);
  }
  if (card.controller !== state.turn.currentPlayerId) {
    throw new Error(`Card ${action.cardId} is not controlled by ${state.turn.currentPlayerId}`);
  }

  const adjacent = adjacentLocationIds(state.board, card.locationId);
  if (!adjacent.includes(action.toLocationId)) {
    throw new Error(`${action.toLocationId} is not adjacent to ${card.locationId}`);
  }

  // A revealed Blend character automatically re-blends on arrival — not a
  // player choice. Reveals only ever happen via an ability, a response, the
  // protected-targeting window, or being forced by another card's effect;
  // moving never asks.
  const faceUp = card.faceUp === true && hasAttribute(cardData, card, "Blend") ? false : card.faceUp;

  const cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, locationId: action.toLocationId, faceUp } : c,
  );

  return { ...state, cards, turn: spendAction(state) };
}

function applyPlayCard(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "playCard" }>,
): GameState {
  requireBudgetedAction(state);

  const cardIndex = state.cards.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  const card = state.cards[cardIndex]!;

  if (card.zone !== "hand" || card.controller !== state.turn.currentPlayerId) {
    throw new Error(`Card ${action.cardId} is not in ${state.turn.currentPlayerId}'s hand`);
  }
  if (card.kind === "motorcade") {
    throw new Error("Motorcade cards are played with playMotorcade, not playCard");
  }

  const location = state.board.find((loc) => loc.id === action.locationId);
  if (!location) {
    throw new Error(`Unknown location: ${action.locationId}`);
  }
  const allowedTypes = getAllowedLocationTypes(cardData, card);
  if (!allowedTypes.includes(location.type)) {
    throw new Error(
      `${card.defRef} cannot be played at a ${location.type} location (allowed: ${allowedTypes.join(", ")})`,
    );
  }

  // Blend-attribute cards always enter play face-down automatically —
  // never a player choice, same principle as moveCard's auto-reblend.
  const faceUp = !hasAttribute(cardData, card, "Blend");

  const cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, zone: "inPlay" as const, locationId: action.locationId, faceUp } : c,
  );

  return { ...state, cards, turn: spendAction(state) };
}

function applyPlayMotorcade(
  state: GameState,
  action: Extract<Action, { type: "playMotorcade" }>,
): GameState {
  requireBudgetedAction(state);

  const currentPlayerId = state.turn.currentPlayerId;
  const player = state.players.find((p) => p.id === currentPlayerId)!;
  if (!player.hasTakenFirstTurn) {
    throw new Error("Motorcade cannot be played on a player's first turn");
  }

  const cardIndex = state.cards.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  const card = state.cards[cardIndex]!;
  if (card.kind !== "motorcade" || card.zone !== "hand" || card.controller !== currentPlayerId) {
    throw new Error(`Card ${action.cardId} is not a Motorcade in ${currentPlayerId}'s hand`);
  }

  // Does not yet check for a Throng of Admirers/Angry Mob interception —
  // that needs resolution-stack frame dispatch (MotorcadeInterceptionWindowFrame),
  // not built yet. See rev_day_engine_design memory for the full design.
  let cards = state.cards.map((c, i) =>
    i === cardIndex ? { ...c, zone: "discard" as const, controller: null } : c,
  );
  let president = state.president;

  if (president.status === "eliminated") {
    // "After the President has been eliminated, move a card you control to
    // any location" — ignores location-type restrictions, per the general
    // ruling that effects specifying a location for placement do so.
    if (!action.moveOwnCardId || !action.moveToLocationId) {
      throw new Error("Must specify a card and destination to move after the President's elimination");
    }
    const moveIndex = cards.findIndex((c) => c.id === action.moveOwnCardId);
    if (moveIndex === -1) {
      throw new Error(`Unknown card: ${action.moveOwnCardId}`);
    }
    const moving = cards[moveIndex]!;
    if (moving.zone !== "inPlay" || moving.controller !== currentPlayerId) {
      throw new Error(`Card ${action.moveOwnCardId} is not controlled by ${currentPlayerId}`);
    }
    if (!state.board.some((l) => l.id === action.moveToLocationId)) {
      throw new Error(`Unknown location: ${action.moveToLocationId}`);
    }
    cards = cards.map((c, i) => (i === moveIndex ? { ...c, locationId: action.moveToLocationId } : c));
  } else if (president.status === "notEntered") {
    // The first Motorcade played in the game — enters at the first Street
    // location, found by type rather than assuming index 0 (board is
    // data-driven, see boardLayoutFromCardData).
    const firstStreet = state.board.find((l) => l.type === "Street");
    if (!firstStreet) {
      throw new Error("Board has no Street location for the President to enter at");
    }
    president = { status: "alive", locationId: firstStreet.id };
  } else if (president.status === "alive") {
    const currentIndex = state.board.findIndex((l) => l.id === president.locationId);
    const nextIndex = currentIndex + 1;
    if (nextIndex >= state.board.length) {
      // Advancing past the last location: the President survives and the
      // game ends immediately. Nothing yet enforces "no further actions
      // once the game has ended" — that's deferred to the win-condition
      // evaluator, not built yet.
      president = { status: "survived", locationId: null };
    } else {
      president = { status: "alive", locationId: state.board[nextIndex]!.id };
    }
  }
  // status === "survived": Motorcade text has nothing left to do; the card
  // still gets discarded and the action still gets spent above.

  return { ...state, cards, president, turn: spendAction(state) };
}

function applyActivateAbility(
  state: GameState,
  cardData: CardData,
  action: Extract<Action, { type: "activateAbility" }>,
): GameState {
  requireBudgetedAction(state);

  const currentPlayerId = state.turn.currentPlayerId;
  const card = state.cards.find((c) => c.id === action.cardId);
  if (!card) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  // No remote-activation yet (Head of Security etc.) — only the card's own
  // controller can activate it, on their own turn.
  if (card.zone !== "inPlay" || card.controller !== currentPlayerId || card.locationId === undefined) {
    throw new Error(`Card ${action.cardId} is not an in-play card controlled by ${currentPlayerId}`);
  }

  const usageKey = `${card.id}#${action.abilityIndex}`;
  if (state.turn.usedAbilities.includes(usageKey)) {
    throw new Error(`Ability ${action.abilityIndex} on ${card.defRef} has already been used this turn`);
  }

  const rawAbility = getAbilities(cardData, card)[action.abilityIndex];
  if (!rawAbility) {
    throw new Error(`${card.defRef} has no ability at index ${action.abilityIndex}`);
  }
  if (rawAbility.type !== "Activate") {
    throw new Error(`${card.defRef}'s ability ${action.abilityIndex} is a Response, not self-activatable`);
  }

  const effects = getAbilityEffects(card.defRef, action.abilityIndex);
  if (!effects) {
    throw new Error(`${card.defRef}'s ability ${action.abilityIndex} has no encoded effects yet`);
  }

  // Must reveal to use an Activate ability — unconditional, not a choice
  // (same principle as "must reveal to respond" below).
  const cards = state.cards.map((c) => (c.id === card.id ? { ...c, faceUp: true } : c));

  const abilityFrame: AbilityResolutionFrame = {
    kind: "abilityResolution",
    sourceCardId: card.id,
    actingPlayerId: currentPlayerId,
    abilityIndex: action.abilityIndex,
    locationId: card.locationId,
    targetIds: null,
  };
  const resolutionStack: ResolutionFrame[] = rawAbility.alarm
    ? [abilityFrame, buildAlarmFrame(state, card.id, currentPlayerId, card.locationId)]
    : [abilityFrame];

  return {
    ...state,
    cards,
    resolutionStack,
    turn: { ...spendAction(state), usedAbilities: [...state.turn.usedAbilities, usageKey] },
  };
}

// Seating order for an alarm's response pass: starts with the player after
// the triggering (acting) player, wraps around, ends with the triggering
// player — everyone gets a turn, no skipping (contrast the
// protected-targeting reveal window, not built yet, which does skip).
function buildAlarmFrame(
  state: GameState,
  triggeringCardId: string,
  triggeringPlayerId: PlayerId,
  locationId: string,
): AlarmResolutionFrame {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const triggerSeat = seats.find((p) => p.id === triggeringPlayerId)!.seatIndex;
  const n = seats.length;
  const order = Array.from({ length: n }, (_, i) => {
    const seat = (triggerSeat + i + 1) % n;
    return seats.find((p) => p.seatIndex === seat)!.id;
  });
  return { kind: "alarmResolution", triggeringCardId, triggeringPlayerId, locationId, order, nextIndex: 0 };
}

function applyChooseTargets(
  state: GameState,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  actingPlayerId: PlayerId,
  action: Extract<Action, { type: "chooseTargets" }>,
): GameState {
  if (actingPlayerId !== frame.actingPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn to choose targets for this ability`);
  }

  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId)!;
  const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex)!;
  const effect = definition.effects[0];
  if (!effect || definition.effects.length > 1) {
    throw new Error("Only single-effect abilities are interpreted so far");
  }

  if (effect.verb === "activateRemote") {
    return applyActivateRemote(
      state,
      cardData,
      sourceCard,
      effect,
      actingPlayerId,
      action.targetIds,
      action.remoteAbilityIndex,
    );
  }
  if (effect.verb !== "eliminate") {
    throw new Error(`Effect verb not yet interpreted: ${effect.verb}`);
  }
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }

  // A target chosen after a reveal window already ran once this
  // resolution bypasses Protected-immunity entirely (no window, ever) —
  // that re-choice is final by design, not a fresh declaration.
  const declared = declareEliminateTarget(
    state,
    cardData,
    effect,
    sourceCard,
    actingPlayerId,
    action.targetIds,
    frame.reselectingAfterReveal ?? false,
  );

  if (declared.protectedActive && hasRevealOpportunity(state, declared.locationId, actingPlayerId)) {
    const updatedFrame: AbilityResolutionFrame = { ...frame, targetIds: [declared.targetId] };
    const windowFrame = buildProtectedTargetingWindowFrame(
      state,
      declared.locationId,
      actingPlayerId,
      declared.targetId,
    );
    return {
      ...state,
      resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame, windowFrame],
    };
  }

  return finalizeEliminateEffect(state, declared.targetId);
}

// Validates a declared target (either a card or the President sentinel)
// against the ability's selector, and reports whether Protected-immunity
// is currently active for it — shared by direct ability resolution
// (chooseTargets) and a Response's inline target declaration
// (useResponse), since both are "declare a target for an eliminate
// effect" at heart. bypassProtectionOverride covers both a post-reveal
// re-choice (reselectingAfterReveal) and the DSL's own ignoreProtected —
// either way, the guard-protection check (not the two-player rule, for
// president targets) is skipped entirely.
function declareEliminateTarget(
  state: GameState,
  cardData: CardData,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  actingCard: CardInstance,
  actingPlayerId: PlayerId,
  targetIds: readonly string[],
  bypassProtectionOverride: boolean,
): { targetId: string; locationId: string; protectedActive: boolean } {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  const bypassProtection = (effect.ignoreProtected ?? false) || bypassProtectionOverride;

  if (effect.target.kind === "president") {
    const legal = isLegalPresidentTarget(state, cardData, actingPlayerId, bypassProtection);
    validateTargets(effect.target.count, targetIds, legal ? [PRESIDENT_TARGET_ID] : []);
    return {
      targetId: PRESIDENT_TARGET_ID,
      locationId: state.president.locationId!,
      // The President has no Blend attribute, so his Protected status is
      // always active while alive.
      protectedActive: !bypassProtection && state.president.status === "alive",
    };
  }

  const eligible = resolveEligibleTargets(state, cardData, effect.target, actingCard).filter(
    (c) => bypassProtection || isLegalEliminationTarget(state, cardData, c, actingPlayerId),
  );
  validateTargets(
    effect.target.count,
    targetIds,
    eligible.map((c) => c.id),
  );
  const targetId = targetIds[0]!;
  const declaredCard = state.cards.find((c) => c.id === targetId)!;
  return {
    targetId,
    locationId: declaredCard.locationId!,
    protectedActive: !bypassProtection && isProtectedActive(cardData, declaredCard),
  };
}

// "Activate any [faction] card, controlled by any player, at any
// location" (Head of Security, Guerrilla Commander, Puppet-Master) —
// composes recursively rather than being a flat effect: pick another card
// + one of its unused Activate abilities, then push a *new*
// AbilityResolutionFrame for that ability (respecting its own alarm flag
// and once-per-turn-per-card usage), replacing this frame rather than
// nesting beneath it. Only single-card remote-activation (count 1) is
// implemented — Commander General's "any number of your regime cards"
// variant would need a queue of pending activations, not built yet.
function applyActivateRemote(
  state: GameState,
  cardData: CardData,
  sourceCard: CardInstance,
  effect: Extract<EffectNode, { verb: "activateRemote" }>,
  actingPlayerId: PlayerId,
  targetIds: readonly string[],
  remoteAbilityIndex: number | undefined,
): GameState {
  if (effect.target.ref !== "filter") {
    throw new Error("Only filter-based targeting is interpreted so far");
  }
  if (effect.count.mode !== "exact" || effect.count.value !== 1) {
    throw new Error("Only single-card remote activation is interpreted so far");
  }
  if (targetIds.length !== 1) {
    throw new Error("Remote activation requires exactly one target card");
  }
  if (remoteAbilityIndex === undefined) {
    throw new Error("Remote activation requires remoteAbilityIndex");
  }

  const eligible = resolveEligibleTargets(state, cardData, effect.target, sourceCard);
  const remoteCard = eligible.find((c) => c.id === targetIds[0]);
  if (!remoteCard || remoteCard.locationId === undefined) {
    throw new Error(`${targetIds[0]} is not a legal card to remotely activate`);
  }

  const usageKey = `${remoteCard.id}#${remoteAbilityIndex}`;
  if (state.turn.usedAbilities.includes(usageKey)) {
    throw new Error(`Ability ${remoteAbilityIndex} on ${remoteCard.defRef} has already been used this turn`);
  }

  const rawAbility = getAbilities(cardData, remoteCard)[remoteAbilityIndex];
  if (!rawAbility) {
    throw new Error(`${remoteCard.defRef} has no ability at index ${remoteAbilityIndex}`);
  }
  if (rawAbility.type !== "Activate") {
    throw new Error(`${remoteCard.defRef}'s ability ${remoteAbilityIndex} is a Response, not activatable`);
  }
  if (!getAbilityEffects(remoteCard.defRef, remoteAbilityIndex)) {
    throw new Error(`${remoteCard.defRef}'s ability ${remoteAbilityIndex} has no encoded effects yet`);
  }

  // Must reveal to use an Activate ability — same rule as direct activation.
  const cards = state.cards.map((c) => (c.id === remoteCard.id ? { ...c, faceUp: true } : c));

  // The original acting player is the "triggering player" for any alarm
  // response ordering, not remoteCard's controller — see the
  // remote-activation ruling in card_data.json's alarm_response_rules.
  const newAbilityFrame: AbilityResolutionFrame = {
    kind: "abilityResolution",
    sourceCardId: remoteCard.id,
    actingPlayerId,
    abilityIndex: remoteAbilityIndex,
    locationId: remoteCard.locationId,
    targetIds: null,
  };
  const newFrames: ResolutionFrame[] = rawAbility.alarm
    ? [newAbilityFrame, buildAlarmFrame(state, remoteCard.id, actingPlayerId, remoteCard.locationId)]
    : [newAbilityFrame];

  return {
    ...state,
    cards,
    resolutionStack: [...state.resolutionStack.slice(0, -1), ...newFrames],
    turn: { ...state.turn, usedAbilities: [...state.turn.usedAbilities, usageKey] },
  };
}

// The President isn't a CardInstance, so he can't appear in `state.cards`
// — this sentinel represents him within the same targetIds/eligible-set
// mechanism used for ordinary card targets, rather than needing a second
// parallel target-selection type.
const PRESIDENT_TARGET_ID = "president";

// Applies a single, already-finalized elimination target — either a card
// or the President sentinel. Every currently-encoded ability is
// count-exact-1, so "single" isn't a limitation in practice yet.
function eliminateSingleTarget(state: GameState, targetId: string): Pick<GameState, "cards" | "president"> {
  if (targetId === PRESIDENT_TARGET_ID) {
    return {
      cards: state.cards,
      president: {
        status: "eliminated",
        locationId: null,
        eliminatedAtLocationId: state.president.locationId ?? undefined,
      },
    };
  }
  return {
    president: state.president,
    cards: state.cards.map((c) =>
      c.id === targetId ? { ...c, zone: "eliminated" as const, locationId: undefined, faceUp: undefined } : c,
    ),
  };
}

// Applies a fully-resolved eliminate effect (target already finalized —
// either as originally declared, or reassigned by a protected-targeting
// window) and pops the AbilityResolutionFrame that was awaiting it.
function finalizeEliminateEffect(state: GameState, targetId: string): GameState {
  const { cards, president } = eliminateSingleTarget(state, targetId);
  const popped = { ...state, cards, president, resolutionStack: state.resolutionStack.slice(0, -1) };
  return resumeAlarmIfPaused(popped);
}

// If finishing this ability's resolution leaves a paused AlarmResolutionFrame
// as the new top of the stack, this was a Response resolved via
// useResponse (not a top-level direct activation) — its target declaration
// pushed a pending AbilityResolutionFrame + reveal window *on top of* the
// still-paused alarm frame rather than advancing it. Now that the
// response (and any nested window/re-choice) is fully done, advance the
// pass — the response consumed its turn. A direct activation never has an
// AlarmResolutionFrame beneath its own frame at this point (its own alarm,
// if any, already resolved and popped *before* targets were chosen), so
// this is a no-op there.
function resumeAlarmIfPaused(state: GameState): GameState {
  const top = state.resolutionStack[state.resolutionStack.length - 1];
  if (top && top.kind === "alarmResolution") {
    return advanceAlarmPass(state, top);
  }
  return state;
}

// Single, non-repeating pass: starts after the declaring player, skips
// them and any player with no blended character at the location — see
// card_data.json's protected_targeting_rules.
function buildProtectedTargetingWindowFrame(
  state: GameState,
  locationId: string,
  declaringPlayerId: PlayerId,
  declaredTargetId: string,
): ProtectedTargetingWindowFrame {
  const seats = state.players.slice().sort((a, b) => a.seatIndex - b.seatIndex);
  const declarerSeat = seats.find((p) => p.id === declaringPlayerId)!.seatIndex;
  const n = seats.length;
  const rotated = Array.from(
    { length: n - 1 },
    (_, i) => seats.find((p) => p.seatIndex === (declarerSeat + i + 1) % n)!.id,
  );
  const order = rotated.filter((playerId) =>
    state.cards.some(
      (c) =>
        c.zone === "inPlay" && c.locationId === locationId && c.controller === playerId && c.faceUp === false,
    ),
  );
  return {
    kind: "protectedTargetingWindow",
    declaringPlayerId,
    declaredTargetId,
    locationId,
    order,
    nextIndex: 0,
    anyRevealed: false,
  };
}

// If nobody reveals anything during the pass, the originally declared
// target stands. If *anyone* reveals *anything* — regardless of whether it
// would actually have protected the original target — the target is not
// automatically reassigned; instead control returns to the declaring
// player (AbilityResolutionFrame.reselectingAfterReveal) to freely
// re-choose from the now-current board, Protected and still-blended
// characters included, and that choice is final.
function applyProtectedTargetingWindowAction(
  state: GameState,
  frame: ProtectedTargetingWindowFrame,
  actingPlayerId: PlayerId,
  action: Action,
): GameState {
  const expectedPlayerId = frame.order[frame.nextIndex]!;
  if (actingPlayerId !== expectedPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn in this protected-targeting reveal pass`);
  }

  let cards = state.cards;
  let revealedThisTurn = false;
  if (action.type === "revealBlended") {
    for (const cardId of action.cardIds) {
      const card = state.cards.find((c) => c.id === cardId);
      if (
        !card ||
        card.zone !== "inPlay" ||
        card.controller !== actingPlayerId ||
        card.locationId !== frame.locationId ||
        card.faceUp !== false
      ) {
        throw new Error(`${cardId} is not a blended card ${actingPlayerId} controls at this location`);
      }
    }
    const revealSet = new Set(action.cardIds);
    cards = state.cards.map((c) => (revealSet.has(c.id) ? { ...c, faceUp: true } : c));
    revealedThisTurn = action.cardIds.length > 0;
  } else if (action.type !== "passReveal") {
    throw new Error(`Expected revealBlended or passReveal, got: ${action.type}`);
  }

  const anyRevealed = frame.anyRevealed || revealedThisTurn;
  const withCards = { ...state, cards };
  const nextIndex = frame.nextIndex + 1;
  if (nextIndex < frame.order.length) {
    const updatedFrame: ProtectedTargetingWindowFrame = { ...frame, nextIndex, anyRevealed };
    return { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -1), updatedFrame] };
  }

  const abilityFrame = withCards.resolutionStack[withCards.resolutionStack.length - 2] as AbilityResolutionFrame;
  if (!anyRevealed) {
    const withoutWindow = { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -2), abilityFrame] };
    return finalizeEliminateEffect(withoutWindow, frame.declaredTargetId);
  }

  const reselectFrame: AbilityResolutionFrame = {
    ...abilityFrame,
    targetIds: null,
    reselectingAfterReveal: true,
  };
  return { ...withCards, resolutionStack: [...withCards.resolutionStack.slice(0, -2), reselectFrame] };
}

function validateTargets(count: TargetCount, targetIds: readonly string[], eligibleIds: readonly string[]): void {
  const eligibleSet = new Set(eligibleIds);
  const requiredCount = count.mode === "exact" ? count.value : undefined;
  if (requiredCount !== undefined && targetIds.length !== requiredCount) {
    throw new Error(`This ability requires exactly ${requiredCount} target(s)`);
  }
  for (const targetId of targetIds) {
    if (!eligibleSet.has(targetId)) {
      throw new Error(`${targetId} is not a legal target for this ability`);
    }
  }
}

function applyAlarmAction(
  state: GameState,
  cardData: CardData,
  frame: AlarmResolutionFrame,
  actingPlayerId: PlayerId,
  action: Action,
): GameState {
  const expectedPlayerId = frame.order[frame.nextIndex]!;
  if (actingPlayerId !== expectedPlayerId) {
    throw new Error(`It is not ${actingPlayerId}'s turn to respond to this alarm`);
  }

  if (action.type === "passResponse") {
    return advanceAlarmPass(state, frame);
  }
  if (action.type !== "useResponse") {
    throw new Error(`Expected useResponse or passResponse during an alarm, got: ${action.type}`);
  }

  const card = state.cards.find((c) => c.id === action.cardId);
  if (!card) {
    throw new Error(`Unknown card: ${action.cardId}`);
  }
  if (card.id === frame.triggeringCardId) {
    throw new Error("The character that triggered the alarm cannot itself respond");
  }
  if (card.zone !== "inPlay" || card.controller !== actingPlayerId || card.locationId !== frame.locationId) {
    throw new Error(`${action.cardId} is not a card ${actingPlayerId} controls at this alarm's location`);
  }

  const rawAbility = getAbilities(cardData, card)[action.abilityIndex];
  if (!rawAbility || rawAbility.type !== "Response") {
    throw new Error(`${card.defRef} has no Response ability at index ${action.abilityIndex}`);
  }
  const effects = getAbilityEffects(card.defRef, action.abilityIndex);
  if (!effects) {
    throw new Error(`${card.defRef}'s Response ability has no encoded effects yet`);
  }
  const effect = effects.effects[0];
  if (!effect || effect.verb !== "eliminate" || effects.effects.length > 1) {
    throw new Error("Only single-effect eliminate Responses are interpreted so far");
  }

  // Must reveal to respond — unconditional, same principle as activating.
  const revealedCards = state.cards.map((c) => (c.id === card.id ? { ...c, faceUp: true } : c));
  const withReveal = { ...state, cards: revealedCards };

  const declared = declareEliminateTarget(
    withReveal,
    cardData,
    effect,
    card,
    actingPlayerId,
    action.targetIds,
    false,
  );

  if (declared.protectedActive && hasRevealOpportunity(withReveal, declared.locationId, actingPlayerId)) {
    // Pause the alarm pass — frame stays exactly as-is, nextIndex
    // unchanged — while a nested reveal window (and any resulting
    // re-choice) resolves on top of it. Resumed by resumeAlarmIfPaused
    // once the pending response finally finishes; see finalizeEliminateEffect.
    const pendingFrame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: card.id,
      actingPlayerId,
      abilityIndex: action.abilityIndex,
      locationId: declared.locationId,
      targetIds: [declared.targetId],
    };
    const windowFrame = buildProtectedTargetingWindowFrame(
      withReveal,
      declared.locationId,
      actingPlayerId,
      declared.targetId,
    );
    return { ...withReveal, resolutionStack: [...withReveal.resolutionStack, pendingFrame, windowFrame] };
  }

  const { cards, president } = eliminateSingleTarget(withReveal, declared.targetId);
  return advanceAlarmPass({ ...withReveal, cards, president }, frame);
}

function advanceAlarmPass(state: GameState, frame: AlarmResolutionFrame): GameState {
  const nextIndex = frame.nextIndex + 1;
  if (nextIndex < frame.order.length) {
    const updatedFrame: AlarmResolutionFrame = { ...frame, nextIndex };
    return { ...state, resolutionStack: [...state.resolutionStack.slice(0, -1), updatedFrame] };
  }

  // The pass is complete. "If the triggering character is eliminated by a
  // response, the rest of the original ability does not resolve" — cancel
  // the AbilityResolutionFrame beneath too in that case; otherwise leave it
  // for the next chooseTargets call now that the alarm has resolved.
  const triggeringCard = state.cards.find((c) => c.id === frame.triggeringCardId);
  const triggeringCardSurvived = triggeringCard !== undefined && triggeringCard.zone !== "eliminated";
  return { ...state, resolutionStack: triggeringCardSurvived ? state.resolutionStack.slice(0, -1) : [] };
}
