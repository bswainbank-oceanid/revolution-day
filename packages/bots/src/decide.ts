import {
  adjacentLocationIds,
  getAbilities,
  getAbilityEffects,
  getPassive,
  PRESIDENT_TARGET_ID,
  winConditions,
} from "@rev-day/engine";
import type {
  Action,
  AbilityDefinition,
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  CardData,
  EffectNode,
  FilteredCardInstance,
  FilteredGameState,
  MotorcadeInterceptionWindowFrame,
  PlayerId,
  ProtectedTargetingWindowFrame,
  ReactivePassiveWindowFrame,
  TargetCount,
} from "@rev-day/engine";
import type { PresidentObjective } from "./presidentObjective";
import { presidentObjectiveFor } from "./presidentObjective";
import type { Rng } from "./random";
import { coinFlip, pickN, pickRandom, pickWeighted } from "./random";
import { asCardInstance, candidateHandCards, candidateInPlayCards, knownFaction, presidentIsLegalTarget } from "./targetPool";

// The full "brain": one decision at a time, given the current (filtered —
// no hidden identities) state. Pure, no I/O, doesn't call applyAction
// itself — see takeBotTurn.ts for the retry/orchestration loop that
// actually drives a whole turn using this. Crude by design: trial and
// error rather than a legal-action enumerator (the engine has none built
// either), weighted-random top-level choices, and a soft preference for
// eliminating things and, per the acting leader's own win condition
// (derived from data, not a hardcoded leader list — see
// presidentObjective.ts), for the President specifically.
export function decideBotAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  rng: Rng = Math.random,
): Action {
  const objective = computeObjective(state, playerId);
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  if (!frame) {
    return decideTurnAction(state, playerId, cardData, objective, rng);
  }
  switch (frame.kind) {
    case "abilityResolution":
      return decideChooseTargets(state, playerId, cardData, frame, objective, rng);
    case "alarmResolution":
      return decideAlarmAction(state, playerId, cardData, frame, objective, rng);
    case "protectedTargetingWindow":
      return decideRevealAction(state, playerId, frame, rng);
    case "motorcadeInterceptionWindow":
      return decideInterceptAction(state, playerId, frame, rng);
    case "reactivePassiveWindow":
      return decideReactiveAction(state, playerId, cardData, frame, rng);
  }
}

function computeObjective(state: FilteredGameState, playerId: PlayerId): PresidentObjective {
  const leader = state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  if (!leader || leader.defRef === null) return "neutral";
  return presidentObjectiveFor(leader.defRef, winConditions);
}

function abilityTargetsPresident(def: AbilityDefinition): boolean {
  return def.effects.some((e) => e.verb === "eliminate" && e.target.ref === "filter" && e.target.kind === "president");
}

function abilityHasEliminateEffect(def: AbilityDefinition): boolean {
  return def.effects.some((e) => e.verb === "eliminate");
}

// Exact/range-minimum eliminate/reveal/peek/activateRemote/play effects
// have no legal "decline" once the ability is already committed to —
// unlike every resolution-stack window (which always has a pass/decline
// option), an activateAbility/useResponse choice with zero available
// candidates for its first effect is a dead end the bot can never
// recover from (a real, pre-existing engine gap: there's no "cancel a
// chosen ability with nothing to target" action). So this checks
// *before* committing, not after — only the ability's first effect, not
// the whole sequence (a later effect running dry is rarer and harder to
// predict up front; the retry/fallback mechanism absorbs that instead).
function abilityHasAvailableFirstTarget(
  state: FilteredGameState,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  def: AbilityDefinition,
): boolean {
  const effect = def.effects[0];
  if (!effect) return false;
  switch (effect.verb) {
    case "eliminate":
    case "reveal":
    case "peek":
    case "activateRemote": {
      if (effect.target.ref !== "filter") return true; // self/binding — nothing to run out of
      if (effect.target.kind === "president") {
        // Only "eliminate" targets the President in current data (Wife) —
        // reveal/peek/activateRemote can't reach this branch yet, so
        // there's nothing to legality-check for them.
        if (effect.verb !== "eliminate") return true;
        const coLocated =
          effect.target.location?.mode !== "self" || state.president.locationId === sourceCard.locationId;
        return presidentIsLegalTarget(state, cardData, sourceCard.controller, effect.ignoreProtected ?? false, coLocated);
      }
      if (effect.verb === "eliminate" && effect.target.selection === "random") return true; // engine draws automatically
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard);
      // The bot never player-chooses to eliminate its own cards (a hard
      // exclusion, not just a preference — see decideEliminateTargetIds),
      // so an eliminate ability with no *opposing* target is just as much
      // a dead end as one with no target at all, unless the selector
      // already hard-constrains controller itself.
      const relevantPool =
        effect.verb === "eliminate" && effect.target.controller !== "self" && effect.target.controller !== "other"
          ? pool.filter((c) => c.controller !== sourceCard.controller)
          : pool;
      return relevantPool.length >= minNeeded;
    }
    case "play": {
      if (effect.target.ref !== "filter") return true;
      const minNeeded = requiredMinCount(effect.target.count);
      if (minNeeded === 0) return true;
      return candidateHandCards(state, cardData, effect.target, sourceCard.controller!).length >= minNeeded;
    }
    case "move": {
      // Only a president-targeted, forwardOrBackward move is interpreted
      // (Traffic Cop) — the same real dead end as the cases above: once
      // activated, there's no legal "decline" if the President isn't
      // actually at this card's location, or has nowhere to go.
      if (effect.target.ref !== "filter" || effect.target.kind !== "president") return true;
      if (state.president.status !== "alive" || !state.president.locationId) return false;
      if (effect.target.location?.mode === "self" && state.president.locationId !== sourceCard.locationId) return false;
      if (effect.destination.mode === "forwardOrBackward") {
        return adjacentLocationIds(state.board, state.president.locationId).length > 0;
      }
      return true;
    }
    default:
      return true; // triggerAlarm/gainActions/draw/returnToHand/blend/gainControl/if always have some submission
  }
}

function requiredMinCount(count: TargetCount): number {
  switch (count.mode) {
    case "exact":
      return count.value;
    case "range":
      return count.min;
    case "all":
    case "unbounded":
      return 0;
  }
}

// --- Top-level turn actions (resolution stack empty) ---

function decideTurnAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  if (state.turn.phase === "draw") return { type: "draw" };
  if (state.turn.actionsRemaining <= 0) return { type: "endTurn" };

  const category = pickWeighted(rng, [
    ["playCard", 40],
    ["draw", 30],
    ["activateAbility", 20],
    ["moveCard", 10],
  ] as const);

  switch (category) {
    case "draw":
      return { type: "draw" };
    case "playCard":
      return decidePlayCardOrMotorcade(state, playerId, rng);
    case "activateAbility":
      return decideActivateAbility(state, playerId, cardData, objective, rng);
    case "moveCard":
      return decideMoveCard(state, playerId, rng);
  }
}

function decidePlayCardOrMotorcade(state: FilteredGameState, playerId: PlayerId, rng: Rng): Action {
  const hand = state.cards.filter((c) => c.zone === "hand" && c.controller === playerId);
  const card = pickRandom(rng, hand);
  if (!card) return { type: "endTurn" };

  if (card.kind === "motorcade") {
    if (state.president.status === "eliminated") {
      const ownInPlay = state.cards.filter((c) => c.zone === "inPlay" && c.controller === playerId);
      const moving = pickRandom(rng, ownInPlay);
      const location = pickRandom(rng, state.board);
      if (!moving || !location) return { type: "endTurn" };
      return { type: "playMotorcade", cardId: card.id, moveOwnCardId: moving.id, moveToLocationId: location.id };
    }
    return { type: "playMotorcade", cardId: card.id };
  }

  const location = pickRandom(rng, state.board);
  if (!location) return { type: "endTurn" };
  return { type: "playCard", cardId: card.id, locationId: location.id };
}

function decideMoveCard(state: FilteredGameState, playerId: PlayerId, rng: Rng): Action {
  const ownInPlay = state.cards.filter((c) => c.zone === "inPlay" && c.controller === playerId);
  const card = pickRandom(rng, ownInPlay);
  if (!card?.locationId) return { type: "endTurn" };
  const adjacent = adjacentLocationIds(state.board, card.locationId);
  const toLocationId = pickRandom(rng, adjacent);
  if (!toLocationId) return { type: "endTurn" };
  return { type: "moveCard", cardId: card.id, toLocationId };
}

function decideActivateAbility(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  const ownInPlay = state.cards.filter((c) => c.zone === "inPlay" && c.controller === playerId && c.defRef !== null);
  const card = pickRandom(rng, ownInPlay);
  if (!card) return { type: "endTurn" };
  const instance = asCardInstance(card)!;

  const usable = getAbilities(cardData, instance)
    .map((ability, abilityIndex) => ({ ability, abilityIndex }))
    .filter(({ ability, abilityIndex }) => {
      if (ability.type !== "Activate") return false;
      if (state.turn.usedAbilities.includes(`${card.id}#${abilityIndex}`)) return false;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) return false;
      if (objective === "protect" && abilityTargetsPresident(def)) return false;
      if (!abilityHasAvailableFirstTarget(state, cardData, card, def)) return false;
      return true;
    });
  if (usable.length === 0) return { type: "endTurn" };

  const eliminateCapable = usable.filter(
    ({ abilityIndex }) => abilityHasEliminateEffect(getAbilityEffects(instance.defRef, abilityIndex)!),
  );
  const chosen = pickRandom(rng, eliminateCapable.length > 0 ? eliminateCapable : usable)!;
  return { type: "activateAbility", cardId: card.id, abilityIndex: chosen.abilityIndex };
}

// --- AbilityResolutionFrame: chooseTargets ---

function decideChooseTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  frame: AbilityResolutionFrame,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  const empty = { type: "chooseTargets" as const, targetIds: [] as readonly string[] };
  const sourceCard = state.cards.find((c) => c.id === frame.sourceCardId);
  if (!sourceCard || sourceCard.defRef === null) return empty;
  const definition = getAbilityEffects(sourceCard.defRef, frame.abilityIndex);
  const effect = definition?.effects[frame.effectIndex ?? 0];
  if (!effect) return empty;

  switch (effect.verb) {
    case "eliminate": {
      const targetIds = decideEliminateTargetIds(state, playerId, cardData, sourceCard, effect, objective, rng);
      return { type: "chooseTargets", targetIds };
    }
    case "reveal":
    case "peek":
      return { type: "chooseTargets", targetIds: decideRevealOrPeekTargetIds(state, cardData, sourceCard, effect, rng) };
    case "play":
      return decidePlayTargets(state, playerId, cardData, effect, rng);
    case "activateRemote":
      return decideActivateRemoteTargets(state, cardData, sourceCard, effect, rng);
    case "move":
      return decideMoveEffectTargets(state, rng);
    case "triggerAlarm":
      return decideTriggerAlarmTargets(effect, state, rng);
    case "gainControl":
    case "returnToHand":
    case "blend":
    case "gainActions":
    case "draw":
    case "if":
      return empty; // always ref:"self"/"binding" or otherwise automatic — nothing to choose
  }
}

function decideEliminateTargetIds(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  effect: Extract<EffectNode, { verb: "eliminate" }>,
  objective: PresidentObjective,
  rng: Rng,
): readonly string[] {
  if (effect.target.ref === "self" || effect.target.ref === "binding") return [];
  if (effect.target.ref !== "filter") return [];
  if (effect.target.selection === "random") return []; // engine draws automatically

  // Only Wife's ability currently has kind:"president" — no alternative
  // candidate exists either way, so there's no real "choice" here, but
  // this is also where an "eliminate" objective's preference for the
  // President would bite if a future ability offered a genuine mix.
  if (effect.target.kind === "president") {
    return [PRESIDENT_TARGET_ID];
  }

  const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard);
  // "Targets are randomly chosen from opposing cards. Don't target your
  // own cards" — a hard exclusion, not a preference with an own-card
  // fallback: abilityHasAvailableFirstTarget already refuses to activate
  // an eliminate ability with no opposing candidate, so this should never
  // actually need to fall back to `pool`.
  const finalPool =
    effect.target.controller === "self" || effect.target.controller === "other"
      ? pool // already hard-constrained by the selector itself
      : pool.filter((c) => c.controller !== playerId);

  const count = countToPick(rng, effect.target.count, finalPool.length);
  return pickN(rng, finalPool, count).map((c) => c.id);
}

function decideRevealOrPeekTargetIds(
  state: FilteredGameState,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  effect: Extract<EffectNode, { verb: "reveal" | "peek" }>,
  rng: Rng,
): readonly string[] {
  if (effect.target.ref !== "filter") return [];
  if (effect.target.count.mode === "all") return []; // forced, confirm-only
  const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard);
  const count = countToPick(rng, effect.target.count, pool.length);
  return pickN(rng, pool, count).map((c) => c.id);
}

function decidePlayTargets(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  effect: Extract<EffectNode, { verb: "play" }>,
  rng: Rng,
): Action {
  if (effect.target.ref !== "filter") return { type: "chooseTargets", targetIds: [] };
  const pool = candidateHandCards(state, cardData, effect.target, playerId);
  const count = countToPick(rng, effect.target.count, pool.length);
  const chosen = pickN(rng, pool, count);
  const targetIds = chosen.map((c) => c.id);

  if (effect.location.mode === "any") {
    const locationIds = targetIds.map(() => pickRandom(rng, state.board)?.id).filter((id): id is string => id !== undefined);
    return { type: "chooseTargets", targetIds, locationIds };
  }
  return { type: "chooseTargets", targetIds };
}

function decideActivateRemoteTargets(
  state: FilteredGameState,
  cardData: CardData,
  sourceCard: FilteredCardInstance,
  effect: Extract<EffectNode, { verb: "activateRemote" }>,
  rng: Rng,
): Action {
  if (effect.target.ref !== "filter") return { type: "chooseTargets", targetIds: [] };
  // Must know the candidate's own identity to pick one of its abilities —
  // a hidden card can't be remotely activated by a bot that can't see it.
  const pool = candidateInPlayCards(state, cardData, effect.target, sourceCard).filter((c) => c.defRef !== null);
  const chosenCard = pickRandom(rng, pool);
  if (!chosenCard) return { type: "chooseTargets", targetIds: [] }; // "no more" for an unbounded queue, or just fails/retries

  const instance = asCardInstance(chosenCard)!;
  const activatable = getAbilities(cardData, instance)
    .map((ability, abilityIndex) => ({ ability, abilityIndex }))
    .filter(({ ability, abilityIndex }) => {
      if (ability.type !== "Activate") return false;
      if (state.turn.usedAbilities.includes(`${chosenCard.id}#${abilityIndex}`)) return false;
      // Same "no legal decline once committed" dead end as a normal
      // activateAbility choice — remote activation pushes this ability's
      // own AbilityResolutionFrame, so an empty candidate pool for it is
      // just as fatal (a real bug: Head of Security remotely activated
      // Death Squad's eliminate-1-or-2 ability with nothing left at its
      // location, and got stuck the same way).
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      return def ? abilityHasAvailableFirstTarget(state, cardData, chosenCard, def) : false;
    });
  const chosenAbility = pickRandom(rng, activatable);
  if (!chosenAbility) return { type: "chooseTargets", targetIds: [] };

  return { type: "chooseTargets", targetIds: [chosenCard.id], remoteAbilityIndex: chosenAbility.abilityIndex };
}

function decideMoveEffectTargets(state: FilteredGameState, rng: Rng): Action {
  if (state.president.status !== "alive" || !state.president.locationId) {
    return { type: "chooseTargets", targetIds: [] };
  }
  const adjacent = adjacentLocationIds(state.board, state.president.locationId);
  const chosen = pickRandom(rng, adjacent);
  if (!chosen) return { type: "chooseTargets", targetIds: [] };
  return { type: "chooseTargets", targetIds: [], locationIds: [chosen] };
}

function decideTriggerAlarmTargets(
  effect: Extract<EffectNode, { verb: "triggerAlarm" }>,
  state: FilteredGameState,
  rng: Rng,
): Action {
  if (effect.location.mode !== "any") return { type: "chooseTargets", targetIds: [] };
  const chosen = pickRandom(rng, state.board);
  if (!chosen) return { type: "chooseTargets", targetIds: [] };
  return { type: "chooseTargets", targetIds: [], locationIds: [chosen.id] };
}

function countToPick(rng: Rng, count: TargetCount, poolSize: number): number {
  switch (count.mode) {
    case "exact":
      return Math.min(count.value, poolSize);
    case "range": {
      const max = Math.min(count.max, poolSize);
      const min = Math.min(count.min, max);
      if (max <= 0) return 0;
      return min + Math.floor(rng() * (max - min + 1));
    }
    case "all":
      return poolSize;
    case "unbounded":
      return Math.floor(rng() * (poolSize + 1));
  }
}

// --- AlarmResolutionFrame: useResponse / passResponse ---

function decideAlarmAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  frame: AlarmResolutionFrame,
  objective: PresidentObjective,
  rng: Rng,
): Action {
  const candidates = state.cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId === frame.locationId &&
      c.id !== frame.triggeringCardId &&
      c.defRef !== null,
  );

  const options: { cardId: string; abilityIndex: number; hasEliminate: boolean }[] = [];
  for (const card of candidates) {
    const instance = asCardInstance(card)!;
    for (const [abilityIndex, ability] of getAbilities(cardData, instance).entries()) {
      if (ability.type !== "Response") continue;
      const def = getAbilityEffects(instance.defRef, abilityIndex);
      if (!def) continue;
      if (objective === "protect" && abilityTargetsPresident(def)) continue;
      if (!abilityHasAvailableFirstTarget(state, cardData, card, def)) continue;
      options.push({ cardId: card.id, abilityIndex, hasEliminate: abilityHasEliminateEffect(def) });
    }
  }
  if (options.length === 0) return { type: "passResponse" };

  const eliminateOptions = options.filter((o) => o.hasEliminate);
  // "Tries to eliminate other cards when it can" — prefer acting with an
  // eliminate-capable Response over passing; otherwise mostly random.
  const shouldAct = eliminateOptions.length > 0 || coinFlip(rng, 0.5);
  if (!shouldAct) return { type: "passResponse" };

  const chosen = pickRandom(rng, eliminateOptions.length > 0 ? eliminateOptions : options)!;
  const sourceCard = state.cards.find((c) => c.id === chosen.cardId)!;
  const def = getAbilityEffects(sourceCard.defRef!, chosen.abilityIndex)!;
  const effect = def.effects[0];
  const targetIds =
    effect && effect.verb === "eliminate"
      ? decideEliminateTargetIds(state, playerId, cardData, sourceCard, effect, objective, rng)
      : [];
  return { type: "useResponse", cardId: chosen.cardId, abilityIndex: chosen.abilityIndex, targetIds };
}

// --- ProtectedTargetingWindowFrame: revealBlended / passReveal ---

function decideRevealAction(
  state: FilteredGameState,
  playerId: PlayerId,
  frame: ProtectedTargetingWindowFrame,
  rng: Rng,
): Action {
  const ownBlended = state.cards.filter(
    (c) => c.zone === "inPlay" && c.controller === playerId && c.locationId === frame.locationId && c.faceUp === false,
  );
  if (ownBlended.length === 0 || !coinFlip(rng, 0.5)) return { type: "passReveal" };
  const count = 1 + Math.floor(rng() * ownBlended.length);
  return { type: "revealBlended", cardIds: pickN(rng, ownBlended, count).map((c) => c.id) };
}

// --- MotorcadeInterceptionWindowFrame: interceptMotorcade / passIntercept ---

function decideInterceptAction(
  state: FilteredGameState,
  playerId: PlayerId,
  frame: MotorcadeInterceptionWindowFrame,
  rng: Rng,
): Action {
  const eligible = state.cards.filter(
    (c) =>
      c.zone === "inPlay" &&
      c.controller === playerId &&
      c.locationId === frame.presidentLocationId &&
      c.defRef !== null &&
      getPassive(c.defRef)?.kind === "motorcadeInterception",
  );
  if (eligible.length === 0 || !coinFlip(rng, 0.5)) return { type: "passIntercept" };
  const chosen = pickRandom(rng, eligible)!;
  return { type: "interceptMotorcade", cardId: chosen.id };
}

// --- ReactivePassiveWindowFrame: playReactive / passReactive ---

function decideReactiveAction(
  state: FilteredGameState,
  playerId: PlayerId,
  cardData: CardData,
  frame: ReactivePassiveWindowFrame,
  rng: Rng,
): Action {
  const pool = state.cards.filter((c) => {
    if (c.zone !== "hand" || c.controller !== playerId) return false;
    if (frame.faction && knownFaction(cardData, c) !== frame.faction) return false;
    return true;
  });
  if (pool.length === 0 || !coinFlip(rng, 0.5)) return { type: "passReactive" };
  const count = 1 + Math.floor(rng() * pool.length);
  return { type: "playReactive", cardIds: pickN(rng, pool, count).map((c) => c.id) };
}
