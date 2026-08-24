export { cardData } from "./data/cardData";
export type {
  CardData,
  LeaderCard,
  NonLeaderCard,
  PresidentData,
  MotorcadeData,
  Ability,
  Faction,
  LocationType,
  Attribute,
} from "./types";

export { boardLayoutFromCardData, adjacentLocationIds } from "./state/board";
export type { BoardLayout, LocationInstance } from "./state/board";
export type { CardInstance, Zone, CardKind } from "./state/cards";
export type { GameState, Player, PlayerId, PresidentState, TurnState } from "./state/game";
export { createRng, nextFloat, nextInt, shuffle } from "./state/rng";
export type { RngState } from "./state/rng";
export type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  ProtectedTargetingWindowFrame,
  MotorcadeInterceptionWindowFrame,
  ResolutionFrame,
  PendingPassiveTrigger,
} from "./state/resolution";
export type { Action, TurnAction, ResolutionAction } from "./actions";
export { setupGame } from "./setup";
export type { SetupOptions } from "./setup";
export { applyAction } from "./reducer";
export { hasAttribute, getAllowedLocationTypes, getAbilities, getFaction } from "./state/cardLookup";
export { getAbilityEffects, abilityEffects } from "./data/abilityEffects";
export {
  resolveEligibleTargets,
  resolveEligibleHandCards,
  partitionByProtection,
  isLegalEliminationTarget,
  isLegalPresidentTarget,
} from "./effects/targeting";
export type {
  AbilityDefinition,
  EffectNode,
  TargetSelector,
  TargetCount,
  TargetSelection,
  CardKindFilter,
  ControllerFilter,
  LocationScope,
  RandomPool,
  Condition,
  ConditionOperand,
  MoveDestination,
} from "./effects/dsl";
export { evaluateWinConditions } from "./effects/winConditions";
export type { WinPredicate } from "./effects/winConditions";
export { winConditions } from "./data/winConditions";
export type { PassiveDefinition } from "./effects/passives";
export { getPassive, passives } from "./data/passives";

import { cardData } from "./data/cardData";

/**
 * Placeholder entry point proving the engine package loads and types its
 * data correctly. Replace/extend once the state model, action interface,
 * and resolution stack are designed.
 */
export function getEngineInfo() {
  return {
    game: cardData.game,
    leaderCount: cardData.leaders.length,
    nonLeaderCount: cardData.non_leader_cards.length,
    locations: cardData.locations_in_order,
  };
}
