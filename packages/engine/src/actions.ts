// Fine-grained actions: one player decision = one action, so the resolution
// stack, bots, UI, and network all share the same decision points rather
// than an ability resolving atomically. See rev_day_engine_design memory.

// Legal when the resolution stack is empty (normal turn flow) — the 5
// action types from turn_structure.action_phase, plus ending the turn
// early (never required to spend both actions).
export type TurnAction =
  | { readonly type: "draw" }
  | { readonly type: "playCard"; readonly cardId: string; readonly locationId: string }
  | {
      readonly type: "playMotorcade";
      readonly cardId: string;
      // Required once the President has been eliminated — "move a card
      // you control to any location" replaces the forward-move.
      readonly moveOwnCardId?: string;
      readonly moveToLocationId?: string;
    }
  | { readonly type: "moveCard"; readonly cardId: string; readonly toLocationId: string }
  | { readonly type: "activateAbility"; readonly cardId: string; readonly abilityIndex: number }
  | { readonly type: "endTurn" };

// Legal only when the resolution stack is non-empty — what the top frame
// demands. Each variant corresponds to one ResolutionFrame kind.
export type ResolutionAction =
  // AbilityResolutionFrame, once its alarm (if any) has resolved.
  | { readonly type: "chooseTargets"; readonly targetIds: readonly string[] }
  // AlarmResolutionFrame: use a Response ability, or decline.
  | {
      readonly type: "useResponse";
      readonly cardId: string;
      readonly abilityIndex: number;
      readonly targetIds: readonly string[];
    }
  | { readonly type: "passResponse" }
  // ProtectedTargetingWindowFrame: reveal any number of blended cards, or
  // decline — a single non-repeating pass, so declining ends that player's
  // turn in the pass, not the whole window.
  | { readonly type: "revealBlended"; readonly cardIds: readonly string[] }
  | { readonly type: "passReveal" }
  // MotorcadeInterceptionWindowFrame: eliminate the eligible card to
  // cancel the move, or decline.
  | { readonly type: "interceptMotorcade"; readonly cardId: string }
  | { readonly type: "passIntercept" };

export type Action = TurnAction | ResolutionAction;
