import { useCallback, useEffect, useRef, useState } from "react";
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
  startingPlayerId: PlayerId,
): string {
  if (isSourceCard) return describeEntry(entry, priorState, humanPlayerId, botPlayerIds, startingPlayerId);
  const { action, resultingState, actingPlayerId } = entry;
  const who =
    actingPlayerId === humanPlayerId
      ? "You"
      : playerLabel(resultingState, actingPlayerId, humanPlayerId, botPlayerIds, startingPlayerId);
  const targetName = cardName(resultingState, viewerCardId);
  const how = describeHow(action, priorState, resultingState);
  return how ? `${who} targeting ${targetName} — ${how}.` : `${who} targeting ${targetName}.`;
}

interface Beat {
  readonly entryIndex: number;
  readonly viewerCardId: string | null;
  readonly cameraTarget: CameraTarget;
  readonly caption: string | null;
  // Beats with nothing actually worth reviewing — the single mandatory
  // draw that opens a turn (free, doesn't cost an action, see reducer.ts's
  // applyDraw) and the synthetic turn-start camera reset below — so "Check
  // Opponent's Turns" skips pausing on them even though they're still an
  // opponent beat. Every other opponent beat (plays, moves, ability
  // activations, targets, alarm responses, a later *voluntary* draw spent
  // from actionsRemaining) still pauses.
  readonly skipPause: boolean;
  // True only for the synthetic turn-start-to-City-View reset beat below
  // — it names no card and has nothing to actually look at, so it always
  // advances immediately regardless of whose entry it's attributed to
  // (see the main pacing effect's own use of this).
  readonly isTurnBoundary: boolean;
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
  startingPlayerId: PlayerId,
  chainStack: Chain[],
  // The true state before log[0] — there's no log[-1] to fall back on, so
  // without this, the very first logged entry (almost always the
  // starting player's own opening draw) would wrongly compare against
  // its own resulting state instead of the pristine pre-draw one below.
  initialState: FilteredGameState,
): { readonly beats: Beat[]; readonly turnStartCount: number } {
  const beats: Beat[] = [];
  let turnStartCount = 0;

  for (let i = fromIndex; i < log.length; i++) {
    const entry = log[i]!;
    const priorState = i > 0 ? log[i - 1]!.resultingState : initialState;
    const { action } = entry;
    const isOpeningDraw = action.type === "draw" && priorState.turn.phase === "draw";

    // endTurn itself has nothing to narrate — no card, no camera change
    // worth a beat — so it gets no beat (and so no pause) at all; the
    // City View reset players actually see happens separately, as the
    // turn-start beat below once play reaches the human.
    const sequence = action.type === "endTurn" ? [] : computeViewerCardSequence(entry, priorState);
    const beatCards = sequence.length > 0 ? sequence : action.type === "endTurn" ? [] : [null];
    let entryInitiatorCardId: string | null = null;
    beatCards.forEach((viewerCardId, idx) => {
      if (idx === 0) entryInitiatorCardId = viewerCardId;
      const isSourceCard = viewerCardId !== null && action.type !== "chooseTargets" && idx === 0;
      const caption = viewerCardId
        ? computeBeatCaption(entry, priorState, viewerCardId, isSourceCard, humanPlayerId, botPlayerIds, startingPlayerId)
        : null;
      beats.push({
        entryIndex: i,
        viewerCardId,
        cameraTarget: computeCameraTarget(entry, priorState, viewerCardId),
        caption,
        skipPause: isOpeningDraw,
        isTurnBoundary: false,
      });
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
          skipPause: false,
          isTurnBoundary: false,
        });
      }
    }

    // This entry itself pushed new resolution frame(s) — open a chain
    // rooted at whatever card this entry's own beats were about.
    if (resultLen > priorLen) {
      chainStack.push({ baseline: priorLen, initiatorCardId: entryInitiatorCardId });
    }

    // A fresh turn boundary into the human's own turn: reset the camera to
    // City View, as the very last beat for this entry so it structurally
    // wins over everything narrated before it. The Card Viewer itself is
    // deliberately left alone here — it keeps showing whatever was most
    // recently played/acting (viewerCardId: null means "no override", see
    // playbackViewerCardId below), not reset back to the Leader. Skipped
    // for i === 0 — the very first log entry never synthesizes this;
    // initial load already starts on the Leader anyway (App.tsx's own
    // fallback, before anything has ever been shown).
    const priorCurrentPlayerId = i > 0 ? log[i - 1]!.resultingState.turn.currentPlayerId : null;
    const newCurrentPlayerId = entry.resultingState.turn.currentPlayerId;
    if (i > 0 && priorCurrentPlayerId !== humanPlayerId && newCurrentPlayerId === humanPlayerId) {
      beats.push({ entryIndex: i, viewerCardId: null, cameraTarget: { kind: "city" }, caption: null, skipPause: true, isTurnBoundary: true });
      turnStartCount++;
    }

    // The reverse boundary — leaving the human's own turn (their last
    // action already earned its own real pacing delay, see
    // isHumanBeatBeforeHandoff below) — also resets to City View, so the
    // camera doesn't jump straight from their own card's location to
    // wherever the next player's first action happens with no transition
    // at all. Not counted in turnStartCount — that signal is specifically
    // for "a new turn started *for the human*" (App.tsx's own resting-view
    // reset), not this one.
    if (priorCurrentPlayerId === humanPlayerId && newCurrentPlayerId !== humanPlayerId) {
      beats.push({ entryIndex: i, viewerCardId: null, cameraTarget: { kind: "city" }, caption: null, skipPause: true, isTurnBoundary: true });
    }
  }

  return { beats, turnStartCount };
}

export interface TurnPlaybackResult {
  // Never null once a session exists — falls back to the true final state
  // whenever playback has nothing (yet) to narrate.
  readonly displayState: FilteredGameState | null;
  // True while stepping through beats at all — camera ownership, the
  // resting-view-reset effects, and the Game Over screen's own timing all
  // key off this broad signal, regardless of whose beat it is. It does
  // *not* mean interaction should be locked, though — see
  // locksInteraction below for that specific question.
  readonly isPlaying: boolean;
  // True only while the *current* beat genuinely isn't the human's own to
  // keep acting through — an opponent's beat, or a turn-boundary reset
  // (see Beat.isTurnBoundary). False for the human's own action beats
  // even while isPlaying is still true and one is technically pacing in
  // the background — they should never be blocked from immediately
  // taking their next action just because a prior beat of their own
  // hasn't finished its own (possibly still-undetermined, see
  // isHumanBeatBeforeHandoff) hold yet. This is what callers should
  // actually gate manual navigation/interaction on.
  readonly locksInteraction: boolean;
  // Overrides the Card Viewer's own selection while a beat names a card;
  // null when there's nothing to override (fall back to normal viewing).
  readonly playbackViewerCardId: string | null;
  // The current beat's "who/how targeted" (or summary) text, for the
  // merged Activate/Actions box's status area; null when nothing to show.
  readonly playbackCaption: string | null;
  // Whoever the current beat's own log entry belongs to — the "current
  // player or the player performing the reaction" color-coding callers
  // use while playback is narrating (see decider() for the equivalent
  // once playback has finished and a real decision is pending). Null
  // whenever there's no current beat.
  readonly playbackActorId: PlayerId | null;
  // How many of `log`'s entries have actually been narrated so far — the
  // Game Log (and anything else reading the raw log directly) should
  // slice to this instead of log.length, or it reads as "running ahead"
  // of what playback has actually shown yet, especially noticeable while
  // paused on awaitingContinue in Check mode (the whole point of pausing
  // is reviewing one step at a time, not seeing the ending already
  // spoiled in the log beside it). Equals log.length once playback has
  // fully caught up.
  readonly revealedLogLength: number;
  // Increments once per detected turn-start boundary into the human's own
  // turn — callers react to a change in this to reset their own resting
  // view state (Card Viewer selection, City View) to match what the last
  // playback beat already showed.
  readonly turnStartSignal: number;
  // True whenever "Check Opponent's Turns" mode has paused playback on an
  // opponent's beat, waiting for continueBeat() — the caller's "Continue"
  // button should be enabled exactly when this is true (and otherwise
  // disabled or hidden, since clicking it does nothing until then).
  readonly awaitingContinue: boolean;
  // Advances exactly one beat — the only way playback moves forward while
  // paused for awaitingContinue. Harmless to call otherwise (nothing is
  // currently waiting on it), but callers should still gate the button
  // itself on awaitingContinue so it doesn't read as always-clickable.
  readonly continueBeat: () => void;
}

// log/finalState/humanPlayerId/botPlayerIds are nullable so this can be
// called unconditionally (Rules of Hooks) even before a game session
// exists.
export function useTurnPlayback(
  log: readonly LogEntry[] | null,
  finalState: FilteredGameState | null,
  humanPlayerId: PlayerId | null,
  botPlayerIds: readonly PlayerId[] | null,
  startingPlayerId: PlayerId | null,
  onCamera: (target: CameraTarget) => void,
  // "Watch" (false) keeps every beat — human's and opponents' — on the
  // same timed pace as always. "Check" (true) leaves the human's own
  // beats on that same timed pace but pauses on every *opponent* beat
  // (except beats with nothing to review — see Beat.skipPause) until
  // continueBeat() is called — see TurnPlaybackResult's own comments on
  // awaitingContinue/continueBeat.
  checkOpponentTurns: boolean,
  // The pristine pre-game state — see buildBeats' own comment on why
  // log[0] needs this instead of a log[-1] that doesn't exist.
  initialState: FilteredGameState | null,
): TurnPlaybackResult {
  const beatsRef = useRef<Beat[]>([]);
  const consumedLogLengthRef = useRef(0);
  const chainStackRef = useRef<Chain[]>([]);
  const turnStartSignalRef = useRef(0);
  const [beatIndex, setBeatIndex] = useState(0);

  // Append newly-arrived log entries as fresh beats during render — safe
  // under StrictMode's double-invoke since consumedLogLengthRef makes this
  // idempotent for the same log.
  if (log && humanPlayerId && botPlayerIds && startingPlayerId && initialState && log.length > consumedLogLengthRef.current) {
    const { beats: newBeats, turnStartCount } = buildBeats(
      log,
      consumedLogLengthRef.current,
      humanPlayerId,
      botPlayerIds,
      startingPlayerId,
      chainStackRef.current,
      initialState,
    );
    beatsRef.current = [...beatsRef.current, ...newBeats];
    consumedLogLengthRef.current = log.length;
    turnStartSignalRef.current += turnStartCount;
  }

  const beats = beatsRef.current;
  const currentBeat = beatIndex < beats.length ? beats[beatIndex]! : null;
  const currentEntry = currentBeat && log ? log[currentBeat.entryIndex] : null;
  const playbackActorId = currentEntry?.actingPlayerId ?? null;
  const isOpponentBeat = !!currentEntry && currentEntry.actingPlayerId !== humanPlayerId;
  const awaitingContinue = checkOpponentTurns && !!currentBeat && isOpponentBeat && !currentBeat.skipPause;
  const continueBeat = useCallback(() => setBeatIndex((i) => i + 1), []);

  // A human beat only earns the real pacing delay once it's the *last*
  // one before control passes to someone else (or play just ends here) —
  // between their own consecutive actions (draw, then play, then play
  // again), there's nothing to wait for: they already know what they just
  // did, and an artificial hold there only makes them wait a second time,
  // after the fact, for no reason. The moment the *next* beat belongs to
  // a different actor, though, this is the one beat where they should get
  // a real moment to see their own last move before the view changes —
  // so this still needs the full delay, same as any bot beat.
  //
  // "Departing" can't just compare actingPlayerId, though: the automatic
  // end-of-turn action once actionsRemaining hits 0 (see useGame.ts's
  // runUntilHumanDecision) is still submitted *as* the human — it's the
  // one that actually flips turn.currentPlayerId away from them, and it
  // produces no beat of its own, but the synthetic "leaving the human's
  // turn" beat built for it right above shares its actingPlayerId too.
  // Comparing plain actorId would see that beat as "same actor, keep
  // going" and wrongly skip the delay on the human's real last action.
  // isTurnBoundary is the reliable signal instead — it's true for that
  // beat regardless of whose entry it's attributed to.
  const nextBeat = beatIndex + 1 < beats.length ? beats[beatIndex + 1] : null;
  const nextEntry = nextBeat && log ? log[nextBeat.entryIndex] : null;
  const isDeparting =
    !nextBeat || nextBeat.isTurnBoundary || (!!nextEntry && !!currentEntry && nextEntry.actingPlayerId !== currentEntry.actingPlayerId);
  const isHumanBeatBeforeHandoff = !isOpponentBeat && !currentBeat?.isTurnBoundary && !!currentEntry && isDeparting;

  useEffect(() => {
    if (!currentBeat) return;
    onCamera(currentBeat.cameraTarget);
    if (checkOpponentTurns && isOpponentBeat && !currentBeat.skipPause) return; // paused — advanced only by continueBeat()
    const advance = () => setBeatIndex((i) => i + 1);
    if (PACING_DELAY_MS === 0) {
      advance(); // test mode — fully synchronous, no yield, for speed
      return;
    }
    // The synthetic turn-start-to-City-View beat names no card and has
    // nothing to actually look at — it never earns its own delay, no
    // matter whose entry it's attributed to (see Beat.isTurnBoundary's
    // own comment); a bot's own beat always does (so the human can watch
    // and follow what it did); a human's own beat only does at the
    // handoff point described above.
    //
    // Always routed through setTimeout, never a synchronous advance() —
    // even a "no delay" beat still needs to yield to the event loop (and
    // so to a real browser paint) before the next one replaces it, or two
    // fast beats back to back can get batched into a single render with
    // no paint in between, and the first one's camera move never actually
    // becomes visible.
    const shouldPace = !currentBeat.isTurnBoundary && (isOpponentBeat || isHumanBeatBeforeHandoff);
    const timer = setTimeout(advance, shouldPace ? PACING_DELAY_MS : 0);
    return () => clearTimeout(timer);
    // Deliberately keyed only on progress through the beat queue (plus
    // checkOpponentTurns/isOpponentBeat/isHumanBeatBeforeHandoff, which
    // gate whether this effect schedules anything at all), not on
    // onCamera's identity (App.tsx's closure changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatIndex, beats.length, checkOpponentTurns, isOpponentBeat, isHumanBeatBeforeHandoff]);

  if (!log || !finalState || !humanPlayerId) {
    return {
      displayState: null,
      isPlaying: false,
      locksInteraction: false,
      playbackViewerCardId: null,
      playbackCaption: null,
      playbackActorId: null,
      revealedLogLength: 0,
      turnStartSignal: turnStartSignalRef.current,
      awaitingContinue: false,
      continueBeat,
    };
  }

  const displayEntryIndex = currentBeat ? currentBeat.entryIndex : beatIndex > 0 ? beats[beatIndex - 1]!.entryIndex : -1;
  const displayState = displayEntryIndex >= 0 ? (log[displayEntryIndex]?.resultingState ?? finalState) : finalState;
  const isPlaying = beatIndex < beats.length;
  const locksInteraction = !!currentBeat && (isOpponentBeat || currentBeat.isTurnBoundary);
  const playbackViewerCardId = currentBeat ? currentBeat.viewerCardId : null;
  const playbackCaption = currentBeat ? currentBeat.caption : null;
  // Reveal only through whichever entry the *currently shown* beat
  // belongs to — a beat becomes "current" (and its camera/viewer take
  // effect) at the same instant its pacing delay starts counting down, so
  // this line appears in lockstep with that, not ahead of it. Once
  // playback fully catches up (currentBeat null), reveal everything.
  const revealedLogLength = currentBeat ? currentBeat.entryIndex + 1 : log.length;

  return {
    displayState,
    isPlaying,
    locksInteraction,
    playbackViewerCardId,
    playbackCaption,
    playbackActorId,
    revealedLogLength,
    turnStartSignal: turnStartSignalRef.current,
    awaitingContinue,
    continueBeat,
  };
}
