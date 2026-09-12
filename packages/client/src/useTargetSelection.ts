import { useCallback, useEffect, useState } from "react";
import { candidateHandCards, cardData, getAbilityEffects } from "@rev-day/engine";
import type { Action, FilteredCardInstance, FilteredGameState, LocationScope, PlayerId, TargetCount } from "@rev-day/engine";
import { computePendingRealChoice, computeResponseCandidates, usableActivateAbilities } from "./targetDecision";

export interface ActiveCardPick {
  readonly candidates: readonly FilteredCardInstance[];
  readonly count: TargetCount;
  readonly locationScope: LocationScope | undefined;
  // What locationScope's self/adjacent/selfOrAdjacent modes are relative
  // to — undefined only when locationScope is itself undefined or "any"
  // (i.e. navigation should stay free either way).
  readonly refLocationId: string | undefined;
  readonly selectedIds: readonly string[];
  readonly toggle: (card: FilteredCardInstance) => void;
  // Present only for a variable-count selection (range not yet at max, or
  // unbounded) — an exact/at-max selection auto-submits instead, per
  // BUILD_PLAN.md's "no confirms anywhere".
  readonly done?: () => void;
}

export interface ActiveLocationPick {
  readonly candidateLocationIds: readonly string[];
  readonly choose: (locationId: string) => void;
}

// Stage 2 of an activateRemote choice (see useTargetSelection's own
// handling below): once a remote card is picked, this is that card's own
// usable-ability list — `choose` submits both halves of the choice
// together (`chooseTargets` with both targetIds and remoteAbilityIndex),
// `cancel` returns to stage 1 (re-picking a different card).
export interface ActiveRemoteAbilityPick {
  readonly card: FilteredCardInstance;
  readonly abilities: { readonly abilityIndex: number; readonly text: string }[];
  readonly choose: (abilityIndex: number) => void;
  readonly cancel: () => void;
}

interface UseTargetSelectionResult {
  readonly cardPick: ActiveCardPick | null;
  readonly locationPick: ActiveLocationPick | null;
  // Set once the human has clicked a Response ability button (before its
  // own target, if any, is chosen) — useResponse is one atomic action, not
  // mediated by the resolution stack, so this is purely client-side
  // staging. Only non-null while cardPick above is also its target-picker.
  readonly respondingWith: { readonly cardId: string; readonly abilityIndex: number } | null;
  readonly startResponse: (cardId: string, abilityIndex: number) => void;
  readonly viewCardsMode: boolean;
  readonly setViewCardsMode: (v: boolean) => void;
  readonly unsupportedAbility: boolean;
  readonly remoteAbilityPick: ActiveRemoteAbilityPick | null;
  // True only during stage 1 of an activateRemote choice (picking which
  // card to activate) — lets ActivateAbilityBox show a distinct header
  // instead of the generic "CHOOSE TARGETS" one every other cardPick uses.
  readonly isPickingRemoteCard: boolean;
}

// The live UI state for step 6 (BUILD_PLAN.md): given the current
// resolution-stack frame, decides what the human is actually being asked
// to choose right now — a set of cards (with real highlighting via
// targetDecision.ts) or a single location — and turns their clicks into
// the right Action. useGame's runUntilHumanDecision has already
// auto-advanced every trivial case before this ever sees a resolutionStack
// frame, so whatever's here always represents a genuine choice.
//
// state/humanPlayerId are nullable so this can be called unconditionally
// (Rules of Hooks) even before a game session exists.
export function useTargetSelection(
  state: FilteredGameState | null,
  humanPlayerId: PlayerId | null,
  act: (action: Action) => void,
): UseTargetSelectionResult {
  const [selectedTargetIds, setSelectedTargetIds] = useState<readonly string[]>([]);
  const [respondingWith, setRespondingWith] = useState<{ cardId: string; abilityIndex: number } | null>(null);
  const [viewCardsMode, setViewCardsMode] = useState(false);
  // Stage 1->2 of an activateRemote choice: which remote card was picked,
  // if any (see the "cards" handling below). Reset alongside the other
  // per-decision state on a fresh frame.
  const [pendingRemoteCardId, setPendingRemoteCardId] = useState<string | null>(null);

  const topFrame = state ? (state.resolutionStack[state.resolutionStack.length - 1] ?? null) : null;

  // A fresh decision (new frame, new effect step, or a new response
  // choice) always starts with a clean selection — this signature changes
  // exactly when what's being asked changes.
  const frameSignature =
    topFrame === null
      ? "none"
      : topFrame.kind === "abilityResolution"
        ? `ability:${topFrame.sourceCardId}:${topFrame.abilityIndex}:${topFrame.effectIndex ?? 0}:${topFrame.reselectingAfterReveal ?? false}`
        : topFrame.kind === "alarmResolution"
          ? `alarm:${topFrame.triggeringCardId}:${topFrame.nextIndex}:${respondingWith?.cardId ?? ""}:${respondingWith?.abilityIndex ?? ""}`
          : topFrame.kind === "protectedTargetingWindow"
            ? `reveal:${topFrame.locationId}:${topFrame.nextIndex}`
            : topFrame.kind === "reactivePassiveWindow"
              ? `reactive:${topFrame.sourceCardId}:${topFrame.nextIndex}`
              : `other:${topFrame.kind}`;

  useEffect(() => {
    setSelectedTargetIds([]);
    setViewCardsMode(false);
    setPendingRemoteCardId(null);
    if (!topFrame || topFrame.kind !== "alarmResolution") setRespondingWith(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSignature]);

  const toggle = useCallback((card: FilteredCardInstance, count: TargetCount) => {
    setSelectedTargetIds((prev) => {
      if (prev.includes(card.id)) return prev.filter((id) => id !== card.id);
      const max = count.mode === "exact" ? count.value : count.mode === "range" ? count.max : Infinity;
      if (prev.length >= max) return prev; // already at the cap — ignore further clicks
      return [...prev, card.id];
    });
  }, []);

  const startResponse = useCallback((cardId: string, abilityIndex: number) => {
    setRespondingWith({ cardId, abilityIndex });
  }, []);

  let cardPick: ActiveCardPick | null = null;
  let locationPick: ActiveLocationPick | null = null;
  let unsupportedAbility = false;
  let remoteAbilityPick: ActiveRemoteAbilityPick | null = null;
  let isPickingRemoteCard = false;

  if (state && humanPlayerId) {
    if (topFrame?.kind === "abilityResolution") {
      const sourceCard = state.cards.find((c) => c.id === topFrame.sourceCardId);
      const effect = sourceCard?.defRef
        ? getAbilityEffects(sourceCard.defRef, topFrame.abilityIndex)?.effects[topFrame.effectIndex ?? 0]
        : undefined;
      if (sourceCard && effect) {
        const pending = computePendingRealChoice(
          state,
          sourceCard,
          humanPlayerId,
          effect,
          selectedTargetIds,
          topFrame.reselectingAfterReveal ?? false,
        );
        if (!pending) {
          unsupportedAbility = true;
        } else if (pending.kind === "cards" && effect.verb === "activateRemote" && !pendingRemoteCardId) {
          // Stage 1: pick which card to activate. Submitting sets
          // pendingRemoteCardId instead of dispatching an action — the
          // real chooseTargets action needs the ability choice too (see
          // stage 2 below), and both go out together in one call.
          isPickingRemoteCard = true;
          cardPick = buildCardPick(pending.candidates, pending.count, pending.locationScope, sourceCard.locationId, selectedTargetIds, toggle, (ids) => {
            setPendingRemoteCardId(ids[0] ?? null);
          });
        } else if (pending.kind === "cards" && effect.verb === "activateRemote" && pendingRemoteCardId) {
          // Stage 2: pick one of that card's own usable Activate
          // abilities. usableActivateAbilities doesn't assume the card is
          // controlled by the acting player — it's already generic.
          const remoteCard = state.cards.find((c) => c.id === pendingRemoteCardId);
          if (remoteCard) {
            remoteAbilityPick = {
              card: remoteCard,
              abilities: usableActivateAbilities(state, remoteCard, state.turn.usedAbilities, humanPlayerId),
              choose: (abilityIndex) => {
                act({ type: "chooseTargets", targetIds: [remoteCard.id], remoteAbilityIndex: abilityIndex });
                setPendingRemoteCardId(null);
              },
              cancel: () => {
                setPendingRemoteCardId(null);
                // Must also clear the stage-1 selection — buildCardPick's
                // own toggle wrapper silently ignores further clicks once
                // selectedIds.length reaches this effect's count (always 1
                // here), so without this reset, cancelling would
                // permanently block picking a different card.
                setSelectedTargetIds([]);
              },
            };
          }
        } else if (pending.kind === "cards") {
          cardPick = buildCardPick(pending.candidates, pending.count, pending.locationScope, sourceCard.locationId, selectedTargetIds, toggle, (ids) => {
            act({ type: "chooseTargets", targetIds: ids });
          });
        } else {
          locationPick = {
            candidateLocationIds: pending.candidateLocationIds,
            choose: (locationId) => act({ type: "chooseTargets", targetIds: [], locationIds: [locationId] }),
          };
        }
      }
    } else if (topFrame?.kind === "alarmResolution" && respondingWith) {
      const responseCard = state.cards.find((c) => c.id === respondingWith.cardId);
      const responseEffect = responseCard?.defRef
        ? getAbilityEffects(responseCard.defRef, respondingWith.abilityIndex)?.effects[0]
        : undefined;
      if (responseCard && responseEffect?.verb === "eliminate") {
        const candidates = computeResponseCandidates(state, responseCard, humanPlayerId, responseEffect, selectedTargetIds);
        const responseScope = responseEffect.target.ref === "filter" ? responseEffect.target.location : undefined;
        const responseCount = responseEffect.target.ref === "filter" ? responseEffect.target.count : { mode: "exact" as const, value: 1 };
        cardPick = buildCardPick(candidates, responseCount, responseScope, responseCard.locationId, selectedTargetIds, toggle, (ids) => {
          act({ type: "useResponse", cardId: respondingWith.cardId, abilityIndex: respondingWith.abilityIndex, targetIds: ids });
          setRespondingWith(null);
        });
      }
    } else if (topFrame?.kind === "protectedTargetingWindow") {
      const candidates = state.cards.filter(
        (c) => c.zone === "inPlay" && c.controller === humanPlayerId && c.locationId === topFrame.locationId && c.faceUp === false,
      );
      cardPick = buildCardPick(
        candidates,
        { mode: "unbounded" },
        { mode: "specific", locationId: topFrame.locationId },
        topFrame.locationId,
        selectedTargetIds,
        toggle,
        (ids) => {
          act(ids.length > 0 ? { type: "revealBlended", cardIds: ids } : { type: "passReveal" });
        },
      );
    } else if (topFrame?.kind === "reactivePassiveWindow") {
      const selector = {
        ref: "filter" as const,
        ...(topFrame.faction ? { faction: topFrame.faction } : {}),
        count: { mode: "unbounded" as const },
        selection: "playerChoice" as const,
      };
      const candidates = candidateHandCards(state, cardData, selector, humanPlayerId);
      cardPick = buildCardPick(candidates, { mode: "unbounded" }, undefined, undefined, selectedTargetIds, toggle, (ids) => {
        act(ids.length > 0 ? { type: "playReactive", cardIds: ids } : { type: "passReactive" });
      });
    }
  }

  return {
    cardPick,
    locationPick,
    respondingWith,
    startResponse,
    viewCardsMode,
    setViewCardsMode,
    unsupportedAbility,
    remoteAbilityPick,
    isPickingRemoteCard,
  };
}

function buildCardPick(
  candidates: readonly FilteredCardInstance[],
  count: TargetCount,
  locationScope: LocationScope | undefined,
  refLocationId: string | undefined,
  selectedIds: readonly string[],
  toggle: (card: FilteredCardInstance, count: TargetCount) => void,
  submit: (ids: readonly string[]) => void,
): ActiveCardPick {
  const max = count.mode === "exact" ? count.value : count.mode === "range" ? count.max : Infinity;
  const min = count.mode === "exact" ? count.value : count.mode === "range" ? count.min : 0;
  const atCap = selectedIds.length >= max && max !== Infinity;
  const needsDoneButton = count.mode === "unbounded" || (count.mode === "range" && !atCap);

  return {
    candidates,
    count,
    locationScope,
    refLocationId,
    selectedIds,
    toggle: (card) => {
      const willReachCap = !selectedIds.includes(card.id) && selectedIds.length + 1 >= max;
      toggle(card, count);
      // Auto-submit the instant an exact/range-max count is satisfied —
      // no confirm button. Computed against the *next* selection (this
      // click), not the current one.
      if (willReachCap && (count.mode === "exact" || count.mode === "range")) {
        submit([...selectedIds, card.id]);
      }
    },
    done: needsDoneButton && selectedIds.length >= min ? () => submit(selectedIds) : undefined,
  };
}
