import { useEffect, useRef, useState } from "react";
import type { Action, FilteredGameState, PlayerId } from "@rev-day/engine";
import { PACING_DELAY_MS } from "./pacing";
import type { LogEntry } from "./useGame";

// Step 7 of BUILD_PLAN.md: bot-turn playback choreography. Every action
// this session takes (human's and bots') already arrives as one big batch
// per useGame.act()/startNewGame() call — there's no server-side
// streaming — so "watching it happen" is entirely client-side: replay the
// already-known sequence of LogEntry.resultingStates one at a time, at a
// uniform pace, rather than jumping straight to the final state.
//
// Only bot-attributed entries get this treatment. A human-attributed entry
// (the player's own click, or an auto-advanced mandatory draw/forced
// end-turn/trivial target choice) reveals instantly — the human either
// just did it themselves or it needed no ceremony in the first place (see
// BUILD_PLAN.md's "no confirms anywhere").

export type CameraTarget = { readonly kind: "city" } | { readonly kind: "location"; readonly locationId: string } | { readonly kind: "none" };

// Priority order for where the camera goes on a bot-turn step (locked
// design, see BUILD_PLAN.md): (1) an explicit destination the action
// itself names, (2) the President's location if it changed, (3) a card
// the action names, (4) the resolution frame active *before* this action,
// (5) no signal at all. endTurn is a special case: always City View.
function computeCameraTarget(entry: LogEntry, priorState: FilteredGameState): CameraTarget {
  const { action, resultingState } = entry;

  if (action.type === "endTurn") return { kind: "city" };

  if (action.type === "playCard") return { kind: "location", locationId: action.locationId };
  if (action.type === "moveCard") return { kind: "location", locationId: action.toLocationId };
  if (action.type === "playMotorcade" && action.moveToLocationId) {
    return { kind: "location", locationId: action.moveToLocationId };
  }
  if (action.type === "chooseTargets" && action.locationIds && action.locationIds[0]) {
    return { kind: "location", locationId: action.locationIds[0] };
  }

  if (resultingState.president.locationId && resultingState.president.locationId !== priorState.president.locationId) {
    return { kind: "location", locationId: resultingState.president.locationId };
  }

  const namedCardId = firstNamedCardId(action);
  if (namedCardId) {
    const card = resultingState.cards.find((c) => c.id === namedCardId);
    if (card?.locationId) return { kind: "location", locationId: card.locationId };
  }

  const frame = priorState.resolutionStack[priorState.resolutionStack.length - 1];
  if (frame) {
    if ("locationId" in frame && frame.locationId) return { kind: "location", locationId: frame.locationId };
    if ("presidentLocationId" in frame && frame.presidentLocationId) {
      return { kind: "location", locationId: frame.presidentLocationId };
    }
  }

  return { kind: "none" };
}

function firstNamedCardId(action: Action): string | undefined {
  if ("cardId" in action) return action.cardId;
  if ("cardIds" in action && action.cardIds.length > 0) return action.cardIds[0];
  if ("targetIds" in action && action.targetIds.length > 0) return action.targetIds[0];
  return undefined;
}

// Card Viewer sequencing (locked design): a newly-drawn/newly-played card
// gets its own beat; a targeting action shows each target individually,
// then one beat reverting to the acting/source card (only meaningful for
// chooseTargets/useResponse, which have an unambiguous source — a reveal
// or reactive window has no single "acting card" to revert to, so those
// just show their targets with no revert beat).
function computeViewerCardSequence(entry: LogEntry, priorState: FilteredGameState): (string | null)[] {
  const { action } = entry;
  switch (action.type) {
    case "playCard":
    case "playMotorcade":
    case "moveCard":
    case "activateAbility":
    case "interceptMotorcade":
      return [action.cardId];
    case "chooseTargets": {
      if (action.targetIds.length === 0) return [];
      const sourceCardId = topAbilitySourceCardId(priorState);
      return sourceCardId ? [...action.targetIds, sourceCardId] : [...action.targetIds];
    }
    case "useResponse":
      return action.targetIds.length > 0 ? [...action.targetIds, action.cardId] : [action.cardId];
    case "revealBlended":
    case "playReactive":
      return [...action.cardIds];
    case "draw":
    case "endTurn":
    case "passResponse":
    case "passReveal":
    case "passIntercept":
    case "passReactive":
      return [];
  }
}

function topAbilitySourceCardId(state: FilteredGameState): string | undefined {
  const frame = state.resolutionStack[state.resolutionStack.length - 1];
  return frame?.kind === "abilityResolution" ? frame.sourceCardId : undefined;
}

interface Beat {
  readonly entryIndex: number;
  readonly viewerCardId: string | null;
  readonly cameraTarget: CameraTarget;
  readonly instant: boolean;
}

function buildBeats(log: readonly LogEntry[], fromIndex: number, humanPlayerId: PlayerId): Beat[] {
  const beats: Beat[] = [];
  for (let i = fromIndex; i < log.length; i++) {
    const entry = log[i]!;
    if (entry.actingPlayerId === humanPlayerId) {
      beats.push({ entryIndex: i, viewerCardId: null, cameraTarget: { kind: "none" }, instant: true });
      continue;
    }
    const priorState = i > 0 ? log[i - 1]!.resultingState : entry.resultingState;
    const cameraTarget = computeCameraTarget(entry, priorState);
    const viewerCards = computeViewerCardSequence(entry, priorState);
    const sequence = viewerCards.length > 0 ? viewerCards : [null];
    for (const viewerCardId of sequence) {
      beats.push({ entryIndex: i, viewerCardId, cameraTarget, instant: false });
    }
  }
  return beats;
}

export interface TurnPlaybackResult {
  // Never null once a session exists — falls back to the true final state
  // whenever playback has nothing (yet) to narrate.
  readonly displayState: FilteredGameState | null;
  // True while stepping through bot-turn beats — callers should lock
  // manual navigation/interaction for this window (BUILD_PLAN.md: "manual
  // navigation is locked out while useTurnPlayback is actively stepping").
  readonly isPlaying: boolean;
  // Overrides the Card Viewer's own selection while a beat names a card;
  // null when there's nothing to override (fall back to normal viewing).
  readonly playbackViewerCardId: string | null;
}

// log/finalState/humanPlayerId are nullable so this can be called
// unconditionally (Rules of Hooks) even before a game session exists.
export function useTurnPlayback(
  log: readonly LogEntry[] | null,
  finalState: FilteredGameState | null,
  humanPlayerId: PlayerId | null,
  onCamera: (target: CameraTarget) => void,
): TurnPlaybackResult {
  const beatsRef = useRef<Beat[]>([]);
  const consumedLogLengthRef = useRef(0);
  const [beatIndex, setBeatIndex] = useState(0);

  // Append newly-arrived log entries as fresh beats during render — safe
  // under StrictMode's double-invoke since consumedLogLengthRef makes this
  // idempotent for the same log.
  if (log && humanPlayerId && log.length > consumedLogLengthRef.current) {
    const newBeats = buildBeats(log, consumedLogLengthRef.current, humanPlayerId);
    beatsRef.current = [...beatsRef.current, ...newBeats];
    consumedLogLengthRef.current = log.length;
  }

  const beats = beatsRef.current;
  const currentBeat = beatIndex < beats.length ? beats[beatIndex]! : null;

  useEffect(() => {
    if (!currentBeat) return;
    onCamera(currentBeat.cameraTarget);
    const advance = () => setBeatIndex((i) => i + 1);
    if (currentBeat.instant || PACING_DELAY_MS === 0) {
      advance();
      return;
    }
    const timer = setTimeout(advance, PACING_DELAY_MS);
    return () => clearTimeout(timer);
    // Deliberately keyed only on progress through the beat queue, not on
    // onCamera's identity (App.tsx's closure changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatIndex, beats.length]);

  if (!log || !finalState || !humanPlayerId) {
    return { displayState: null, isPlaying: false, playbackViewerCardId: null };
  }

  const displayEntryIndex = currentBeat ? currentBeat.entryIndex : beatIndex > 0 ? beats[beatIndex - 1]!.entryIndex : -1;
  const displayState = displayEntryIndex >= 0 ? (log[displayEntryIndex]?.resultingState ?? finalState) : finalState;
  const isPlaying = beatIndex < beats.length;
  const playbackViewerCardId = currentBeat && !currentBeat.instant ? currentBeat.viewerCardId : null;

  return { displayState, isPlaying, playbackViewerCardId };
}
