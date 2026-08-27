import { useCallback, useEffect, useState } from "react";
import type { FilteredCardInstance, FilteredGameState } from "@rev-day/engine";
import { adjacentLocationIds, asCardInstance, cardData, getAllowedLocationTypes } from "@rev-day/engine";
import "./App.css";
import { ActionsBox } from "./ActionsBox";
import { ActivateAbilityBox } from "./ActivateAbilityBox";
import { CardViewer } from "./CardViewer";
import { CityView } from "./CityView";
import { GameCanvas } from "./GameCanvas";
import { GameChat } from "./GameChat";
import { GameLog } from "./GameLog";
import { HandStrip } from "./HandStrip";
import { LocationView } from "./LocationView";
import { playerLabel } from "./players";
import { TurnRibbon } from "./TurnRibbon";
import type { ActiveCardPick } from "./useTargetSelection";
import { useTargetSelection } from "./useTargetSelection";
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
// is pending, navigation follows/locks to wherever the candidates are
// (single-location locks auto-navigate there; a location-only pick like
// Traffic Cop's or Anarchist's always shows in City View).
function App() {
  const { session, loading, error, startNewGame, act } = useGame();
  const { view, goToCity, goToLocation } = useViewNavigation();
  const [viewedCardId, setViewedCardId] = useState<string | null>(null);
  const [draggedCard, setDraggedCard] = useState<FilteredCardInstance | null>(null);
  const selection = useTargetSelection(session?.state ?? null, session?.humanPlayerId ?? null, act);

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
    if (locked && locked.size === 1) {
      const only = [...locked][0]!;
      goToLocation(only);
    } else if (selection.locationPick) {
      goToCity();
    }
    // Only re-run when what's locked actually changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockSignature]);

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

  const { state, humanPlayerId, botPlayerIds, log } = session;
  const viewedCard =
    (viewedCardId ? state.cards.find((c) => c.id === viewedCardId) : undefined) ??
    state.cards.find((c) => c.kind === "leader" && c.controller === humanPlayerId) ??
    null;
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
  // Motorcade is excluded — it's played via playMotorcade, not a location
  // drop, so there's nothing for it to highlight. Suppressed entirely
  // while a target pick is active — dragging and picking don't mix.
  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const canDrag = (card: FilteredCardInstance): boolean =>
    !loading &&
    !pickActive &&
    canTakeTurnAction &&
    state.turn.actionsRemaining > 0 &&
    card.controller === humanPlayerId &&
    card.defRef !== null &&
    card.kind !== "motorcade" &&
    (card.zone === "hand" || card.zone === "inPlay");

  // Highlighting is exact, not trial-and-error: a hand card's legal
  // locations come from its own printed deploy-location types; an in-play
  // card's legal locations are just board adjacency — both already
  // computed by the engine, not re-derived here.
  const allowedDropLocationIds = new Set<string>();
  if (draggedCard?.zone === "hand") {
    const instance = asCardInstance(draggedCard);
    if (instance) {
      const allowedTypes = getAllowedLocationTypes(cardData, instance);
      for (const l of state.board) if (allowedTypes.includes(l.type)) allowedDropLocationIds.add(l.id);
    }
  } else if (draggedCard?.zone === "inPlay" && draggedCard.locationId) {
    for (const id of adjacentLocationIds(state.board, draggedCard.locationId)) allowedDropLocationIds.add(id);
  }

  const handleDropCard = (locationId: string) => {
    if (draggedCard && allowedDropLocationIds.has(locationId)) {
      if (draggedCard.zone === "hand") {
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
          <CardViewer
            card={viewedCard}
            controllerLabel={controllerLabel}
            draggable={viewedCard ? canDrag(viewedCard) : false}
            onDragStart={setDraggedCard}
            onDragEnd={stopDragging}
          />
          <ActivateAbilityBox card={viewedCard} state={state} humanPlayerId={humanPlayerId} act={act} selection={selection} />
        </>
      }
      center={
        view.kind === "location" ? (
          <LocationView
            state={state}
            locationId={view.locationId}
            humanPlayerId={humanPlayerId}
            botPlayerIds={botPlayerIds}
            onBackgroundClick={goToCity}
            onSelectCard={selectCard}
            canDrag={canDrag}
            onCardDragStart={setDraggedCard}
            onCardDragEnd={stopDragging}
            isDropTarget={allowedDropLocationIds.has(view.locationId)}
            onDropCard={handleDropCard}
            cardPick={selection.cardPick}
            pickModeActive={!!selection.cardPick && !selection.viewCardsMode}
          />
        ) : (
          <CityView
            state={state}
            onSelectLocation={goToLocation}
            allowedDropLocationIds={allowedDropLocationIds}
            onDropCard={handleDropCard}
            locationPick={selection.locationPick}
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
        <>
          <HandStrip
            state={state}
            playerId={humanPlayerId}
            onSelectCard={selectCard}
            canDrag={canDrag}
            onDragStart={setDraggedCard}
            onDragEnd={stopDragging}
            cardPick={selection.cardPick}
            pickModeActive={!!selection.cardPick && !selection.viewCardsMode}
          />
          <ActionsBox state={state} onAct={act} disabled={loading} selection={selection} />
        </>
      }
    />
  );
}

export default App;
