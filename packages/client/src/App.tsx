import { useCallback, useEffect, useState } from "react";
import type { FilteredCardInstance, FilteredGameState } from "@rev-day/engine";
import { adjacentLocationIds, asCardInstance, cardData, getAllowedLocationTypes, knownFaction } from "@rev-day/engine";
import "./App.css";
import { ActivateAbilityBox } from "./ActivateAbilityBox";
import { CardViewer } from "./CardViewer";
import { CityView } from "./CityView";
import { GameCanvas } from "./GameCanvas";
import { GameChat } from "./GameChat";
import { GameLog } from "./GameLog";
import { GameOverScreen } from "./GameOverScreen";
import { HandStrip } from "./HandStrip";
import { LocationView } from "./LocationView";
import { playerLabel } from "./players";
import { TurnRibbon } from "./TurnRibbon";
import { resolveCard } from "./targetDecision";
import type { ActiveCardPick } from "./useTargetSelection";
import { useTargetSelection } from "./useTargetSelection";
import type { CameraTarget } from "./useTurnPlayback";
import { useTurnPlayback } from "./useTurnPlayback";
import { useGame } from "./useGame";
import { useViewNavigation } from "./useViewNavigation";

// Where a card-pick's locationScope resolves to, given its own reference
// location — null means navigation stays free (undefined scope, or "any").
function lockedLocationIds(state: FilteredGameState, pick: ActiveCardPick | null): Set<string> | null {
  if (!pick?.locationScope) return null;
  const scope = pick.locationScope;
  if (scope.mode === "any") return null;
  if (scope.mode === "specific") return new Set([scope.locationId]);
  if (!pick.refLocationId) return null;
  if (scope.mode === "self") return new Set([pick.refLocationId]);
  if (scope.mode === "adjacent") return new Set(adjacentLocationIds(state.board, pick.refLocationId));
  if (scope.mode === "selfOrAdjacent") return new Set([pick.refLocationId, ...adjacentLocationIds(state.board, pick.refLocationId)]);
  return null;
}

// Step 4 of BUILD_PLAN.md: real view navigation (City View <-> Location
// View via useViewNavigation) plus "click a card to view it" / "viewing a
// card navigates to its location" — selecting a card and navigating to
// where it is are the same action, not two separate concerns.
//
// Step 6 adds target selection (useTargetSelection) — while a real choice
// is pending, navigation follows/locks to wherever the candidates are.
//
// Step 7 adds bot-turn playback (useTurnPlayback) — while it's stepping,
// it owns the camera and the Card Viewer's content; the target-selection
// lock effect below explicitly defers to it (both would otherwise fight
// over goToLocation/goToCity, since a pending human pick from the *true*
// final state can already exist while playback is still narrating the
// bot steps leading up to it).
function App() {
  const { session, loading, error, startNewGame, act } = useGame();
  const { view, goToCity, goToLocation } = useViewNavigation();
  const [viewedCardId, setViewedCardId] = useState<string | null>(null);
  const [draggedCard, setDraggedCard] = useState<FilteredCardInstance | null>(null);
  const selection = useTargetSelection(session?.state ?? null, session?.humanPlayerId ?? null, act);
  const handleCamera = useCallback(
    (target: CameraTarget) => {
      if (target.kind === "city") goToCity();
      else if (target.kind === "location") goToLocation(target.locationId);
    },
    [goToCity, goToLocation],
  );
  const playback = useTurnPlayback(
    session?.log ?? null,
    session?.state ?? null,
    session?.humanPlayerId ?? null,
    session?.botPlayerIds ?? null,
    handleCamera,
  );

  // A fresh turn boundary into the human's own turn (see useTurnPlayback's
  // own detection): reset the resting view state — Card Viewer selection
  // and camera — to match what the last playback beat for that boundary
  // already showed (Leader + City View), so nothing flickers back to
  // whatever was being browsed before once playback settles.
  useEffect(() => {
    if (playback.turnStartSignal === 0) return;
    setViewedCardId(null);
    goToCity();
    // Fire only when a new turn-start boundary is detected, not on every
    // render — goToCity's identity is stable (useCallback) but included
    // for clarity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.turnStartSignal]);

  const selectCard = useCallback(
    (card: FilteredCardInstance) => {
      setViewedCardId(card.id);
      if (card.zone === "inPlay" && card.locationId) goToLocation(card.locationId);
    },
    [goToLocation],
  );
  const stopDragging = useCallback(() => setDraggedCard(null), []);

  const locked = session ? lockedLocationIds(session.state, selection.viewCardsMode ? null : selection.cardPick) : null;
  const lockSignature = locked ? [...locked].sort().join(",") : selection.locationPick ? "@city" : "";

  useEffect(() => {
    if (playback.isPlaying) return; // playback owns the camera until it catches up
    if (locked && locked.size === 1) {
      const only = [...locked][0]!;
      goToLocation(only);
    } else if (selection.locationPick) {
      goToCity();
    }
    // Only re-run when what's locked actually changes, or playback hands
    // the camera back — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockSignature, playback.isPlaying]);

  if (!session) {
    return (
      <main className="new-game">
        <h1>Revolution Day</h1>
        <p>Solo vs. bots — this session is you plus 2 bots.</p>
        {error && <p className="error">{error}</p>}
        <button type="button" onClick={startNewGame} disabled={loading}>
          {loading ? "Starting…" : "New Game"}
        </button>
      </main>
    );
  }

  // Step 9: wait for playback to finish narrating the bot turn that ended
  // the game (if any) before showing results — the human should still get
  // to watch what happened, not have it snap away underneath the summary.
  if (session.gameOver && !playback.isPlaying) {
    return (
      <main className="new-game">
        <GameOverScreen
          gameOver={session.gameOver}
          state={session.state}
          humanPlayerId={session.humanPlayerId}
          botPlayerIds={session.botPlayerIds}
        />
        <button type="button" onClick={startNewGame} disabled={loading}>
          {loading ? "Starting…" : "Play Again"}
        </button>
      </main>
    );
  }

  const { humanPlayerId, botPlayerIds, log } = session;
  const state = playback.displayState ?? session.state;
  const interactionLocked = loading || playback.isPlaying;

  // resolveCard covers the President's sentinel id too, alongside real
  // cards — see targetDecision.ts.
  const viewedCard = playback.playbackViewerCardId
    ? (resolveCard(state, playback.playbackViewerCardId) ?? null)
    : ((viewedCardId ? resolveCard(state, viewedCardId) : undefined) ??
      state.cards.find((c) => c.kind === "leader" && c.controller === humanPlayerId) ??
      null);
  const controllerLabel = viewedCard?.controller
    ? viewedCard.controller === humanPlayerId
      ? "You"
      : playerLabel(state, viewedCard.controller, humanPlayerId, botPlayerIds)
    : null;

  const pickActive = !!selection.cardPick || !!selection.locationPick;

  // Step 5 (BUILD_PLAN.md): drag-and-drop play/move. A card can be dragged
  // (from the hand strip, an in-play MiniCard, or the Card Viewer once
  // selected — all three share this one check) only when it's actually
  // the human's own card and a real turn action is available right now.
  // Suppressed entirely while a target pick is active or playback is
  // narrating a bot turn. Motorcade is included — dragging it onto *any*
  // location plays it (the drop location itself isn't used; see
  // handleDropCard) — but only once it's legal to play at all (not the
  // player's first turn).
  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const hasTakenFirstTurn = state.players.find((p) => p.id === humanPlayerId)?.hasTakenFirstTurn ?? false;
  // A hand card (played via playCard/playMotorcade) can spend either the
  // normal budget or a restricted "play" grant (Puppet-Master, Master
  // Assassin, Commander General, Opposition Leader — see
  // RestrictedActionGrant); an in-play card (moved via moveCard) can only
  // ever spend the normal budget — no grant ever pays for a move. A grant
  // only actually covers a given card once its own faction narrowing (if
  // any) is satisfied — Commander General/Opposition Leader restrict to
  // one faction, Puppet-Master/Master Assassin don't restrict at all.
  const playGrant = state.turn.restrictedAction?.kind === "play" ? state.turn.restrictedAction : null;
  const playGrantActive = playGrant !== null && (playGrant.amount === "unbounded" || playGrant.amount > 0);
  const cardQualifiesForPlayGrant = (card: FilteredCardInstance): boolean =>
    playGrantActive && (playGrant!.faction === null || knownFaction(cardData, card) === playGrant!.faction);
  const canDrag = (card: FilteredCardInstance): boolean =>
    !interactionLocked &&
    !pickActive &&
    canTakeTurnAction &&
    (card.zone === "hand"
      ? state.turn.actionsRemaining > 0 || cardQualifiesForPlayGrant(card)
      : state.turn.actionsRemaining > 0) &&
    card.controller === humanPlayerId &&
    card.defRef !== null &&
    (card.kind !== "motorcade" || hasTakenFirstTurn) &&
    (card.zone === "hand" || card.zone === "inPlay");

  // Highlighting is exact, not trial-and-error: a hand card's legal
  // locations come from its own printed deploy-location types; an in-play
  // card's legal locations are just board adjacency — both already
  // computed by the engine, not re-derived here. A dragged Motorcade
  // highlights every location, since the drop location is never actually
  // used (only where you release the drag, as a "play it" gesture) — a
  // Motorcade never qualifies for a restricted play grant anyway (no
  // faction of its own), same as under the old encoding.
  const allowedDropLocationIds = new Set<string>();
  if (draggedCard?.kind === "motorcade") {
    for (const l of state.board) allowedDropLocationIds.add(l.id);
  } else if (draggedCard?.zone === "hand") {
    const instance = asCardInstance(draggedCard);
    const allowedTypes = instance ? getAllowedLocationTypes(cardData, instance) : [];
    if (state.turn.actionsRemaining > 0) {
      for (const l of state.board) if (allowedTypes.includes(l.type)) allowedDropLocationIds.add(l.id);
    }
    if (cardQualifiesForPlayGrant(draggedCard)) {
      if (playGrant!.locationId) {
        allowedDropLocationIds.add(playGrant!.locationId);
      } else if (playGrant!.ignoreLocationRestrictions) {
        for (const l of state.board) allowedDropLocationIds.add(l.id);
      } else {
        for (const l of state.board) if (allowedTypes.includes(l.type)) allowedDropLocationIds.add(l.id);
      }
    }
  } else if (draggedCard?.zone === "inPlay" && draggedCard.locationId) {
    for (const id of adjacentLocationIds(state.board, draggedCard.locationId)) allowedDropLocationIds.add(id);
  }

  const handleDropCard = (locationId: string) => {
    if (draggedCard && allowedDropLocationIds.has(locationId)) {
      if (draggedCard.kind === "motorcade") {
        act({ type: "playMotorcade", cardId: draggedCard.id });
      } else if (draggedCard.zone === "hand") {
        act({ type: "playCard", cardId: draggedCard.id, locationId });
      } else if (draggedCard.zone === "inPlay") {
        act({ type: "moveCard", cardId: draggedCard.id, toLocationId: locationId });
      }
    }
    setDraggedCard(null);
  };

  return (
    <GameCanvas
      ribbon={<TurnRibbon state={state} humanPlayerId={humanPlayerId} botPlayerIds={botPlayerIds} log={log} />}
      left={
        <>
          {error && <p className="error in-game-error">{error}</p>}
          <CardViewer
            card={viewedCard}
            controllerLabel={controllerLabel}
            viewerId={humanPlayerId}
            draggable={viewedCard ? canDrag(viewedCard) : false}
            onDragStart={setDraggedCard}
            onDragEnd={stopDragging}
          />
          <ActivateAbilityBox
            card={viewedCard}
            state={state}
            humanPlayerId={humanPlayerId}
            act={act}
            selection={selection}
            isPlaying={playback.isPlaying}
            playbackCaption={playback.playbackCaption}
            disabled={interactionLocked}
          />
        </>
      }
      center={
        view.kind === "location" ? (
          <LocationView
            state={state}
            locationId={view.locationId}
            humanPlayerId={humanPlayerId}
            botPlayerIds={botPlayerIds}
            onBackgroundClick={interactionLocked ? undefined : goToCity}
            onSelectCard={interactionLocked ? undefined : selectCard}
            canDrag={canDrag}
            onCardDragStart={setDraggedCard}
            onCardDragEnd={stopDragging}
            isDropTarget={allowedDropLocationIds.has(view.locationId)}
            onDropCard={handleDropCard}
            cardPick={selection.cardPick}
            pickModeActive={!interactionLocked && !!selection.cardPick && !selection.viewCardsMode}
          />
        ) : (
          <CityView
            state={state}
            onSelectLocation={interactionLocked ? undefined : goToLocation}
            allowedDropLocationIds={allowedDropLocationIds}
            onDropCard={handleDropCard}
            locationPick={selection.locationPick}
            onSelectCard={interactionLocked ? undefined : selectCard}
            cardPick={selection.cardPick}
            pickModeActive={!interactionLocked && !!selection.cardPick && !selection.viewCardsMode}
          />
        )
      }
      right={
        <>
          <GameLog log={log} humanPlayerId={humanPlayerId} botPlayerIds={botPlayerIds} />
          <GameChat />
        </>
      }
      bottom={
        <HandStrip
          state={state}
          playerId={humanPlayerId}
          onSelectCard={interactionLocked ? undefined : selectCard}
          canDrag={canDrag}
          onDragStart={setDraggedCard}
          onDragEnd={stopDragging}
          cardPick={selection.cardPick}
          pickModeActive={!interactionLocked && !!selection.cardPick && !selection.viewCardsMode}
        />
      }
    />
  );
}

export default App;
