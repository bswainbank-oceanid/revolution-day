import { useEffect, useRef, useState } from "react";
import { asCardInstance, cardData, getAbilities } from "@rev-day/engine";
import type { Action, FilteredGameState, PlayerId } from "@rev-day/engine";
import { PACING_DELAY_MS } from "./pacing";
import { cardName, describeEntry } from "./gameText";
import { playerLabel } from "./players";
import type { LogEntry } from "./useGame";

// Every action this session takes (human's and bots') arrives as one big
// batch per useGame.act()/startNewGame() call — there's no server-side
// streaming — so "watching it happen" is entirely client-side: replay the
// already-known sequence of LogEntry.resultingStates one at a time, at a
// uniform pace, rather than jumping straight to the final state. This now
// applies uniformly to every entry, human or bot — narrating your own
// actions the same way is the point of this redesign, not a special case.

export type CameraTarget = { readonly kind: "city" } | { readonly kind: "location"; readonly locationId: string } | { readonly kind: "none" };

function cardInPlayLocationId(state: FilteredGameState, cardId: string | null): string | undefined {
  if (!cardId) return undefined;
  const card = state.cards.find((c) => c.id === cardId);
  return card?.zone === "inPlay" ? (card.locationId ?? undefined) : undefined;
}

// Priority order for where the camera goes on a given beat: (1) endTurn
// always forces City View, (2) whichever card this specific beat is
// showing, if it's in play — this is what makes "whenever the Viewer is
// showing a card in play, that card's location shows in the center pane"
// true for every beat, not just the first one in a multi-target sequence,
// (3) an explicit destination the action itself names, (4) the President's
// location if it changed, (5) the resolution frame active *before* this
// action, (6) no signal at all.
function computeCameraTarget(entry: LogEntry, priorState: FilteredGameState, beatCardId: string | null): CameraTarget {
  const { action, resultingState } = entry;

  if (action.type === "endTurn") return { kind: "city" };

  const beatLocationId = cardInPlayLocationId(resultingState, beatCardId);
  if (beatLocationId) return { kind: "location", locationId: beatLocationId };

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

  const frame = priorState.resolutionStack[priorState.resolutionStack.length - 1];
  if (frame) {
    if ("locationId" in frame && frame.locationId) return { kind: "location", locationId: frame.locationId };
    if ("presidentLocationId" in frame && frame.presidentLocationId) {
      return { kind: "location", locationId: frame.presidentLocationId };
    }
  }

  return { kind: "none" };
}

// Card Viewer sequencing: a newly-drawn card gets its own beat; a play/
// move/activate shows its own card; a targeting action shows each target
// individually (the source-card revert is handled separately by the chain
// mechanism below, not appended here).
function computeViewerCardSequence(entry: LogEntry, priorState: FilteredGameState): (string | null)[] {
  const { action, resultingState, actingPlayerId } = entry;
  switch (action.type) {
    case "playCard":
    case "playMotorcade":
    case "moveCard":
    case "activateAbility":
    case "interceptMotorcade":
      return [action.cardId];
    case "draw": {
      const drawn = findDrawnCardId(priorState, resultingState, actingPlayerId);
      return drawn ? [drawn] : [];
    }
    case "chooseTargets":
      return [...action.targetIds];
    case "useResponse":
      return action.targetIds.length > 0 ? [action.cardId, ...action.targetIds] : [action.cardId];
    case "revealBlended":
    case "playReactive":
      return [...action.cardIds];
    case "endTurn":
    case "passResponse":
    case "passReveal":
    case "passIntercept":
    case "passReactive":
      return [];
  }
}

function findDrawnCardId(priorState: FilteredGameState, resultingState: FilteredGameState, playerId: PlayerId): string | null {
  const priorHandIds = new Set(priorState.cards.filter((c) => c.zone === "hand" && c.controller === playerId).map((c) => c.id));
  const newHandCard = resultingState.cards.find((c) => c.zone === "hand" && c.controller === playerId && !priorHandIds.has(c.id));
  return newHandCard?.id ?? null;
}

function abilityText(state: FilteredGameState, cardId: string, abilityIndex: number): string | null {
  const card = state.cards.find((c) => c.id === cardId);
  const instance = card ? asCardInstance(card) : null;
  if (!instance) return null;
  return getAbilities(cardData, instance)[abilityIndex]?.text ?? null;
}

// What's driving a target beat, in plain text — the "how" half of "an
// indication of how it's targeted and who".
function describeHow(action: Action, priorState: FilteredGameState, resultingState: FilteredGameState): string | null {
  if (action.type === "chooseTargets") {
    const frame = priorState.resolutionStack[priorState.resolutionStack.length - 1];
    return frame?.kind === "abilityResolution" ? abilityText(priorState, frame.sourceCardId, frame.abilityIndex) : null;
  }
  if (action.type === "useResponse") return abilityText(resultingState, action.cardId, action.abilityIndex);
  if (action.type === "revealBlended") return "revealed";
  if (action.type === "playReactive") return "played as a reactive response";
  return null;
}

// A beat's caption: the entry's own summary line (reusing GameLog's
// phrasing) when this beat is showing the entry's own acting/source card,
// or "{who} targeting {card} — {how}" when it's showing one of its
// targets — the "who"/"how targeted" indication the feature calls for.
function computeBeatCaption(
  entry: LogEntry,
  priorState: FilteredGameState,
  viewerCardId: string,
  isSourceCard: boolean,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
): string {
  if (isSourceCard) return describeEntry(entry, humanPlayerId, botPlayerIds);
  const { action, resultingState, actingPlayerId } = entry;
  const who = actingPlayerId === humanPlayerId ? "You" : playerLabel(resultingState, actingPlayerId, humanPlayerId, botPlayerIds);
  const targetName = cardName(resultingState, viewerCardId);
  const how = describeHow(action, priorState, resultingState);
  return how ? `${who} targeting ${targetName} — ${how}.` : `${who} targeting ${targetName}.`;
}

interface Beat {
  readonly entryIndex: number;
  readonly viewerCardId: string | null;
  readonly cameraTarget: CameraTarget;
  readonly caption: string | null;
}

// A "chain" tracks one still-open cascade of resolution (an ability that
// pushed a frame, an alarm it triggered, etc.) so that once it fully
// closes (the resolution stack returns to the depth it had before the
// chain opened) we can append one more beat returning to whichever card
// started it — "at the end of a resolution stack, return to the card that
// initiated it". A stack, not a single value, so nested cascades (an
// ability whose resolution itself triggers another frame) revert
// correctly, innermost first.
interface Chain {
  readonly baseline: number;
  readonly initiatorCardId: string | null;
}

function buildBeats(
  log: readonly LogEntry[],
  fromIndex: number,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
  chainStack: Chain[],
): { readonly beats: Beat[]; readonly turnStartCount: number } {
  const beats: Beat[] = [];
  let turnStartCount = 0;

  for (let i = fromIndex; i < log.length; i++) {
    const entry = log[i]!;
    const priorState = i > 0 ? log[i - 1]!.resultingState : entry.resultingState;
    const { action } = entry;

    const sequence = computeViewerCardSequence(entry, priorState);
    const beatCards = sequence.length > 0 ? sequence : [null];
    let entryInitiatorCardId: string | null = null;
    beatCards.forEach((viewerCardId, idx) => {
      if (idx === 0) entryInitiatorCardId = viewerCardId;
      const isSourceCard = viewerCardId !== null && action.type !== "chooseTargets" && idx === 0;
      const caption = viewerCardId
        ? computeBeatCaption(entry, priorState, viewerCardId, isSourceCard, humanPlayerId, botPlayerIds)
        : null;
      beats.push({ entryIndex: i, viewerCardId, cameraTarget: computeCameraTarget(entry, priorState, viewerCardId), caption });
    });

    const priorLen = priorState.resolutionStack.length;
    const resultLen = entry.resultingState.resolutionStack.length;

    // Close every chain this entry brought back down to (or below) its own
    // opening depth — innermost first.
    while (chainStack.length > 0 && resultLen <= chainStack[chainStack.length - 1]!.baseline) {
      const closed = chainStack.pop()!;
      if (closed.initiatorCardId) {
        beats.push({
          entryIndex: i,
          viewerCardId: closed.initiatorCardId,
          cameraTarget: computeCameraTarget(entry, priorState, closed.initiatorCardId),
          caption: null,
        });
      }
    }

    // This entry itself pushed new resolution frame(s) — open a chain
    // rooted at whatever card this entry's own beats were about.
    if (resultLen > priorLen) {
      chainStack.push({ baseline: priorLen, initiatorCardId: entryInitiatorCardId });
    }

    // A fresh turn boundary into the human's own turn: reset the Card
    // Viewer to their Leader and the camera to City View, as the very last
    // beat for this entry so it structurally wins over everything
    // narrated before it. Skipped for i === 0 — the very first log entry
    // never synthesizes this; initial load already starts here anyway.
    const priorCurrentPlayerId = i > 0 ? log[i - 1]!.resultingState.turn.currentPlayerId : null;
    const newCurrentPlayerId = entry.resultingState.turn.currentPlayerId;
    if (i > 0 && priorCurrentPlayerId !== humanPlayerId && newCurrentPlayerId === humanPlayerId) {
      const leaderCard = entry.resultingState.cards.find((c) => c.kind === "leader" && c.controller === humanPlayerId);
      beats.push({ entryIndex: i, viewerCardId: leaderCard?.id ?? null, cameraTarget: { kind: "city" }, caption: null });
      turnStartCount++;
    }
  }

  return { beats, turnStartCount };
}

export interface TurnPlaybackResult {
  // Never null once a session exists — falls back to the true final state
  // whenever playback has nothing (yet) to narrate.
  readonly displayState: FilteredGameState | null;
  // True while stepping through beats — callers should lock manual
  // navigation/interaction for this window.
  readonly isPlaying: boolean;
  // Overrides the Card Viewer's own selection while a beat names a card;
  // null when there's nothing to override (fall back to normal viewing).
  readonly playbackViewerCardId: string | null;
  // The current beat's "who/how targeted" (or summary) text, for the
  // merged Activate/Actions box's status area; null when nothing to show.
  readonly playbackCaption: string | null;
  // Increments once per detected turn-start boundary into the human's own
  // turn — callers react to a change in this to reset their own resting
  // view state (Card Viewer selection, City View) to match what the last
  // playback beat already showed.
  readonly turnStartSignal: number;
}

// log/finalState/humanPlayerId/botPlayerIds are nullable so this can be
// called unconditionally (Rules of Hooks) even before a game session
// exists.
export function useTurnPlayback(
  log: readonly LogEntry[] | null,
  finalState: FilteredGameState | null,
  humanPlayerId: PlayerId | null,
  botPlayerIds: readonly PlayerId[] | null,
  onCamera: (target: CameraTarget) => void,
): TurnPlaybackResult {
  const beatsRef = useRef<Beat[]>([]);
  const consumedLogLengthRef = useRef(0);
  const chainStackRef = useRef<Chain[]>([]);
  const turnStartSignalRef = useRef(0);
  const [beatIndex, setBeatIndex] = useState(0);

  // Append newly-arrived log entries as fresh beats during render — safe
  // under StrictMode's double-invoke since consumedLogLengthRef makes this
  // idempotent for the same log.
  if (log && humanPlayerId && botPlayerIds && log.length > consumedLogLengthRef.current) {
    const { beats: newBeats, turnStartCount } = buildBeats(
      log,
      consumedLogLengthRef.current,
      humanPlayerId,
      botPlayerIds,
      chainStackRef.current,
    );
    beatsRef.current = [...beatsRef.current, ...newBeats];
    consumedLogLengthRef.current = log.length;
    turnStartSignalRef.current += turnStartCount;
  }

  const beats = beatsRef.current;
  const currentBeat = beatIndex < beats.length ? beats[beatIndex]! : null;

  useEffect(() => {
    if (!currentBeat) return;
    onCamera(currentBeat.cameraTarget);
    const advance = () => setBeatIndex((i) => i + 1);
    if (PACING_DELAY_MS === 0) {
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
    return {
      displayState: null,
      isPlaying: false,
      playbackViewerCardId: null,
      playbackCaption: null,
      turnStartSignal: turnStartSignalRef.current,
    };
  }

  const displayEntryIndex = currentBeat ? currentBeat.entryIndex : beatIndex > 0 ? beats[beatIndex - 1]!.entryIndex : -1;
  const displayState = displayEntryIndex >= 0 ? (log[displayEntryIndex]?.resultingState ?? finalState) : finalState;
  const isPlaying = beatIndex < beats.length;
  const playbackViewerCardId = currentBeat ? currentBeat.viewerCardId : null;
  const playbackCaption = currentBeat ? currentBeat.caption : null;

  return { displayState, isPlaying, playbackViewerCardId, playbackCaption, turnStartSignal: turnStartSignalRef.current };
}
