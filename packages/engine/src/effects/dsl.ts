import type { Faction } from "../types";

// Declarative effect DSL: ability/win-condition free text gets translated
// into this structured, interpretable data instead of hand-coded per-card
// branches. See rev_day_engine_design memory for the worked examples this
// vocabulary was validated against (Suicide Bomber, Secret Police,
// Motorcade, remote-activation, etc.).

// --- Target selection ---

export type CardKindFilter = "leader" | "nonLeader" | "motorcade" | "president";
export type ControllerFilter = "self" | "any" | "other";

export type LocationScope =
  | { readonly mode: "self" }
  | { readonly mode: "adjacent" }
  | { readonly mode: "selfOrAdjacent" }
  | { readonly mode: "any" }
  | { readonly mode: "specific"; readonly locationId: string };

export type TargetCount =
  | { readonly mode: "exact"; readonly value: number }
  // Player chooses within [min, max] — "eliminate one or two targets".
  | { readonly mode: "range"; readonly min: number; readonly max: number }
  | { readonly mode: "all" }
  // "any number" — unbounded, limited only by what's actually available.
  | { readonly mode: "unbounded" };

export type TargetSelection = "playerChoice" | "random";

// Suicide Bomber's bespoke, location-wide (not per-faction) Protected
// fallback: the primary pool is fully exhausted before the fallback pool
// is touched at all — a per-ability override of the standard Protected
// check, not a reuse of it.
export interface RandomPool {
  readonly pool: "unprotected";
  readonly fallbackPool: "protected";
}

// A selector either resolves to a specific already-known card (the
// ability's own source, or a card bound by an earlier reveal/peek step in
// the same chain) or picks via filters. Kept as a discriminated union
// rather than one loosely-optional shape so the two shortcuts can't be
// combined with filter fields that would be meaningless for them.
export type TargetSelector =
  | { readonly ref: "self" }
  | { readonly ref: "binding"; readonly binding: string }
  | {
      readonly ref: "filter";
      readonly kind?: CardKindFilter;
      readonly faction?: Faction;
      readonly controller?: ControllerFilter;
      readonly location?: LocationScope;
      readonly blendState?: "faceDown" | "faceUp";
      // Only "Protected" is needed so far — Blend is already implied by
      // blendState (only Blend-attribute cards can be face-down at all).
      readonly hasAttribute?: "Protected";
      readonly count: TargetCount;
      readonly selection: TargetSelection;
      readonly randomPool?: RandomPool; // only meaningful when selection === "random"
    };

// --- Conditions (result-binding, not just static branching on state) ---

export type ConditionOperand =
  | { readonly source: "binding"; readonly binding: string; readonly field: "faction" | "kind" }
  | { readonly source: "presidentStatus" };

export type Condition =
  | { readonly op: "equals"; readonly left: ConditionOperand; readonly value: string }
  | { readonly op: "and"; readonly conditions: readonly Condition[] }
  | { readonly op: "or"; readonly conditions: readonly Condition[] };

// --- Move destinations ---

export type MoveDestination =
  | { readonly mode: "forward"; readonly amount: number }
  | { readonly mode: "backward"; readonly amount: number }
  // Player's choice at resolution time — Traffic Cop.
  | { readonly mode: "forwardOrBackward"; readonly amount: number }
  | { readonly mode: "chosen"; readonly location: LocationScope }
  // Bodyguard: follow the President to wherever he just moved.
  | { readonly mode: "matchTriggeringEvent" };

// --- Effect nodes ---

export type EffectNode =
  | {
      readonly verb: "eliminate";
      readonly target: TargetSelector;
      readonly ignoreProtected?: boolean; // Wife's full bypass, distinct from a randomPool fallback
      readonly bind?: string;
    }
  | { readonly verb: "move"; readonly target: TargetSelector; readonly destination: MoveDestination }
  | { readonly verb: "draw"; readonly amount: number }
  | {
      readonly verb: "play";
      readonly target: TargetSelector; // selects from the acting player's hand
      readonly location: LocationScope;
      readonly ignoreLocationRestrictions?: boolean;
    }
  | { readonly verb: "reveal"; readonly target: TargetSelector; readonly bind?: string }
  | { readonly verb: "peek"; readonly target: TargetSelector; readonly bind?: string } // private — acting player only
  | { readonly verb: "blend"; readonly target: TargetSelector }
  | { readonly verb: "gainControl"; readonly target: TargetSelector }
  // `restriction: "play" | "activate"` (Puppet-Master's "Play 2 cards",
  // Master Assassin's "return and play a card", Commander General's "any
  // number... at this location", Opposition Leader's "place 2 rebels at
  // any locations") grants a RestrictedActionGrant (TurnState.
  // restrictedAction) instead of actionsRemaining — a separate budget
  // only playCard/playMotorcade ("play") or activateAbility ("activate")
  // can spend. `amount: "unbounded"` never depletes ("any number").
  // `faction` narrows which cards the grant covers (omitted = any).
  // `location: "self"` forces every use to the granting card's own
  // location (omitted = the player chooses freely, per-use).
  // `ignoreLocationRestrictions` ("play" only) bypasses a card's own
  // printed allowed-location-types while paying from this grant.
  | {
      readonly verb: "gainActions";
      readonly amount: number | "unbounded";
      readonly restriction?: "play" | "activate";
      readonly faction?: Faction;
      readonly location?: "self";
      readonly ignoreLocationRestrictions?: boolean;
    }
  | { readonly verb: "returnToHand"; readonly target: TargetSelector }
  | { readonly verb: "triggerAlarm"; readonly location: LocationScope }
  // Recurses into the same ability-resolution machinery for the chosen
  // card's chosen ability, rather than being a flat primitive.
  | { readonly verb: "activateRemote"; readonly target: TargetSelector; readonly count: TargetCount }
  | {
      readonly verb: "if";
      readonly condition: Condition;
      readonly then: readonly EffectNode[];
      readonly else?: readonly EffectNode[];
    };

export interface AbilityDefinition {
  readonly type: "Activate" | "Response";
  readonly alarm?: boolean;
  readonly effects: readonly EffectNode[];
}
