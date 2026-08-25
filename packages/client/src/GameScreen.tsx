import { useState } from "react";
import { PRESIDENT_TARGET_ID, cardData, getAbilities } from "@rev-day/engine";
import type { Action, FilteredCardInstance, FilteredGameState, PlayerId } from "@rev-day/engine";
import { Board } from "./Board";
import { Hand } from "./Hand";
import { GameOverScreen } from "./GameOverScreen";
import type { GameSession } from "./useGame";

interface GameScreenProps {
  readonly session: GameSession;
  readonly loading: boolean;
  readonly error: string | null;
  readonly act: (action: Action) => Promise<void>;
}

type TurnMode = "idle" | "playCard" | "moveCard" | "activateAbility";

export function GameScreen({ session, loading, error, act }: GameScreenProps) {
  const { state, humanPlayerId, gameOver } = session;

  const [turnMode, setTurnMode] = useState<TurnMode>("idle");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedAbilityIndex, setSelectedAbilityIndex] = useState<number | null>(null);
  // Only used for a Motorcade played after the President's already been
  // eliminated — its text is "move a card you control to any location"
  // instead of a normal forward move, so it needs its own in-play card
  // pick, separate from selectedCardId (which holds the Motorcade itself,
  // a *hand* card, for this same turnMode).
  const [selectedMoveCardId, setSelectedMoveCardId] = useState<string | null>(null);

  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [selectedTargetLocationIds, setSelectedTargetLocationIds] = useState<Set<string>>(new Set());
  const [respondCardId, setRespondCardId] = useState<string | null>(null);
  const [respondAbilityIndex, setRespondAbilityIndex] = useState<number | null>(null);

  function resetTurnSelection() {
    setTurnMode("idle");
    setSelectedCardId(null);
    setSelectedLocationId(null);
    setSelectedAbilityIndex(null);
    setSelectedMoveCardId(null);
  }

  function resetResolutionSelection() {
    setSelectedTargetIds(new Set());
    setSelectedTargetLocationIds(new Set());
    setRespondCardId(null);
    setRespondAbilityIndex(null);
  }

  async function submit(action: Action) {
    // Reset selection *after* the action settles, not before — resetting
    // eagerly flipped turnMode back to "idle" while the request was still
    // in flight, so the base action panel re-rendered a beat before the
    // new state actually arrived (caught live while testing this in a
    // browser: a screenshot mid-request showed the base buttons back with
    // the hand/board still showing the pre-action state, since nothing
    // had changed yet).
    await act(action);
    resetTurnSelection();
    resetResolutionSelection();
  }

  function toggleTarget(id: string) {
    setSelectedTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTargetLocation(id: string) {
    setSelectedTargetLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (gameOver) return <GameOverScreen gameOver={gameOver} />;

  const frame = state.resolutionStack[state.resolutionStack.length - 1];

  // A selected hand card that's a Motorcade needs playMotorcade, not
  // playCard — and if the President's already eliminated, its text
  // changes to "move a card you control to any location" instead of a
  // normal forward move, needing its own in-play-card pick on the board.
  const selectedHandCard = selectedCardId ? state.cards.find((c) => c.id === selectedCardId) : undefined;
  const playingMotorcade = turnMode === "playCard" && selectedHandCard?.kind === "motorcade";
  const motorcadeNeedsMove = playingMotorcade && state.president.status === "eliminated";

  return (
    <div className="game-screen">
      {error && <p className="error">{error}</p>}
      {loading && <p className="hint">Working…</p>}

      <Board
        state={state}
        selectedCardIds={
          frame
            ? selectedTargetIds
            : motorcadeNeedsMove
              ? selectedCardOrLocSet(selectedMoveCardId)
              : turnMode !== "idle"
                ? selectedCardOrLocSet(selectedCardId)
                : undefined
        }
        onCardClick={
          frame
            ? (id) => toggleTarget(id)
            : motorcadeNeedsMove
              ? (id) => setSelectedMoveCardId(id)
              : turnMode !== "idle"
                ? (id) => onTurnCardClick(id)
                : undefined
        }
        selectedLocationIds={
          frame ? selectedTargetLocationIds : turnMode !== "idle" ? selectedCardOrLocSet(selectedLocationId) : undefined
        }
        onLocationClick={
          frame
            ? (id) => toggleTargetLocation(id)
            : turnMode === "moveCard" || (turnMode === "playCard" && (motorcadeNeedsMove || !playingMotorcade))
              ? (id) => setSelectedLocationId(id)
              : undefined
        }
      />

      <Hand
        state={state}
        playerId={humanPlayerId}
        selectedCardIds={turnMode === "playCard" ? selectedCardOrLocSet(selectedCardId) : undefined}
        onCardClick={turnMode === "playCard" ? (id) => setSelectedCardId(id) : undefined}
      />

      {!frame && (
        <TurnActionPanel
          state={state}
          humanPlayerId={humanPlayerId}
          turnMode={turnMode}
          setTurnMode={(m) => {
            resetTurnSelection();
            setTurnMode(m);
          }}
          selectedCardId={selectedCardId}
          selectedLocationId={selectedLocationId}
          selectedAbilityIndex={selectedAbilityIndex}
          setSelectedAbilityIndex={setSelectedAbilityIndex}
          playingMotorcade={playingMotorcade}
          motorcadeNeedsMove={motorcadeNeedsMove}
          selectedMoveCardId={selectedMoveCardId}
          onCancel={resetTurnSelection}
          onSubmit={submit}
        />
      )}

      {frame && (
        <ResolutionPanel
          state={state}
          humanPlayerId={humanPlayerId}
          frame={frame}
          selectedTargetIds={selectedTargetIds}
          selectedTargetLocationIds={selectedTargetLocationIds}
          respondCardId={respondCardId}
          setRespondCardId={setRespondCardId}
          respondAbilityIndex={respondAbilityIndex}
          setRespondAbilityIndex={setRespondAbilityIndex}
          onSubmit={submit}
        />
      )}
    </div>
  );

  function onTurnCardClick(id: string) {
    if (turnMode === "moveCard" || turnMode === "activateAbility") setSelectedCardId(id);
  }
}

function selectedCardOrLocSet(id: string | null): Set<string> {
  return id ? new Set([id]) : new Set();
}

// --- Turn-level actions (resolution stack empty) ---

interface TurnActionPanelProps {
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly turnMode: TurnMode;
  readonly setTurnMode: (mode: TurnMode) => void;
  readonly selectedCardId: string | null;
  readonly selectedLocationId: string | null;
  readonly selectedAbilityIndex: number | null;
  readonly setSelectedAbilityIndex: (index: number) => void;
  readonly playingMotorcade: boolean;
  readonly motorcadeNeedsMove: boolean;
  readonly selectedMoveCardId: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (action: Action) => Promise<void>;
}

function TurnActionPanel({
  state,
  humanPlayerId,
  turnMode,
  setTurnMode,
  selectedCardId,
  selectedLocationId,
  selectedAbilityIndex,
  setSelectedAbilityIndex,
  playingMotorcade,
  motorcadeNeedsMove,
  selectedMoveCardId,
  onCancel,
  onSubmit,
}: TurnActionPanelProps) {
  const isMyTurn = state.turn.currentPlayerId === humanPlayerId;
  if (!isMyTurn) return <p className="hint">Waiting…</p>;

  if (state.turn.phase === "draw") {
    return (
      <div className="action-panel">
        <button type="button" onClick={() => onSubmit({ type: "draw" })}>
          Draw
        </button>
      </div>
    );
  }

  const selectedCard = selectedCardId ? state.cards.find((c) => c.id === selectedCardId) : undefined;

  return (
    <div className="action-panel">
      {turnMode === "idle" && (
        <>
          <button type="button" onClick={() => setTurnMode("playCard")}>
            Play Card
          </button>
          <button type="button" onClick={() => setTurnMode("moveCard")}>
            Move Card
          </button>
          <button type="button" onClick={() => setTurnMode("activateAbility")}>
            Activate Ability
          </button>
          <button type="button" onClick={() => onSubmit({ type: "endTurn" })}>
            End Turn
          </button>
        </>
      )}

      {turnMode === "playCard" && playingMotorcade && !motorcadeNeedsMove && (
        <>
          <p className="hint">
            A Motorcade moves the President forward automatically — no location needed. Just confirm.
          </p>
          <button type="button" disabled={!selectedCardId} onClick={() => onSubmit({ type: "playMotorcade", cardId: selectedCardId! })}>
            Confirm
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {turnMode === "playCard" && motorcadeNeedsMove && (
        <>
          <p className="hint">
            The President's already been eliminated — this Motorcade instead moves one of your own cards. Click one
            of your in-play cards, then a destination.
          </p>
          <button
            type="button"
            disabled={!selectedCardId || !selectedMoveCardId || !selectedLocationId}
            onClick={() =>
              onSubmit({
                type: "playMotorcade",
                cardId: selectedCardId!,
                moveOwnCardId: selectedMoveCardId!,
                moveToLocationId: selectedLocationId!,
              })
            }
          >
            Confirm
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {turnMode === "playCard" && !playingMotorcade && (
        <>
          <p className="hint">Click a hand card, then a location.</p>
          <button
            type="button"
            disabled={!selectedCardId || !selectedLocationId}
            onClick={() => onSubmit({ type: "playCard", cardId: selectedCardId!, locationId: selectedLocationId! })}
          >
            Confirm
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {turnMode === "moveCard" && (
        <>
          <p className="hint">Click one of your in-play cards, then a location.</p>
          <button
            type="button"
            disabled={!selectedCardId || !selectedLocationId}
            onClick={() => onSubmit({ type: "moveCard", cardId: selectedCardId!, toLocationId: selectedLocationId! })}
          >
            Confirm
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {turnMode === "activateAbility" && (
        <>
          <p className="hint">Click one of your in-play cards.</p>
          {selectedCard && selectedCard.defRef && (
            <AbilityPicker
              card={selectedCard}
              selectedIndex={selectedAbilityIndex}
              onSelect={setSelectedAbilityIndex}
            />
          )}
          <button
            type="button"
            disabled={!selectedCardId || selectedAbilityIndex === null}
            onClick={() => onSubmit({ type: "activateAbility", cardId: selectedCardId!, abilityIndex: selectedAbilityIndex! })}
          >
            Confirm
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

function AbilityPicker({
  card,
  selectedIndex,
  onSelect,
}: {
  readonly card: FilteredCardInstance;
  readonly selectedIndex: number | null;
  readonly onSelect: (index: number) => void;
}) {
  if (card.defRef === null) return null;
  const abilities = getAbilities(cardData, { ...card, defRef: card.defRef });
  return (
    <ul className="ability-list">
      {abilities.map((ability, index) => (
        <li key={index}>
          <label>
            <input
              type="radio"
              name="ability"
              checked={selectedIndex === index}
              onChange={() => onSelect(index)}
            />
            [{ability.type}{ability.alarm ? ", alarm" : ""}] {ability.text}
          </label>
        </li>
      ))}
    </ul>
  );
}

// --- Resolution-stack actions ---

interface ResolutionPanelProps {
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly frame: FilteredGameState["resolutionStack"][number];
  readonly selectedTargetIds: Set<string>;
  readonly selectedTargetLocationIds: Set<string>;
  readonly respondCardId: string | null;
  readonly setRespondCardId: (id: string | null) => void;
  readonly respondAbilityIndex: number | null;
  readonly setRespondAbilityIndex: (index: number | null) => void;
  readonly onSubmit: (action: Action) => Promise<void>;
}

function ResolutionPanel({
  state,
  humanPlayerId,
  frame,
  selectedTargetIds,
  selectedTargetLocationIds,
  respondCardId,
  setRespondCardId,
  respondAbilityIndex,
  setRespondAbilityIndex,
  onSubmit,
}: ResolutionPanelProps) {
  switch (frame.kind) {
    case "abilityResolution": {
      if (frame.actingPlayerId !== humanPlayerId) return <p className="hint">Waiting…</p>;
      return (
        <div className="action-panel">
          <p className="hint">
            Click cards/locations to target (the "President" button targets him directly). Submit with nothing
            selected to decline, if allowed.
          </p>
          <button type="button" onClick={() => toggleAndSubmitPresident(selectedTargetIds, onSubmit)}>
            Target the President
          </button>
          <button
            type="button"
            onClick={() =>
              onSubmit({
                type: "chooseTargets",
                targetIds: [...selectedTargetIds],
                locationIds: selectedTargetLocationIds.size ? [...selectedTargetLocationIds] : undefined,
              })
            }
          >
            Submit
          </button>
        </div>
      );
    }
    case "alarmResolution": {
      const responder = frame.order[frame.nextIndex];
      if (responder !== humanPlayerId) return <p className="hint">Waiting…</p>;
      const candidates = state.cards.filter(
        (c) => c.zone === "inPlay" && c.controller === humanPlayerId && c.locationId === frame.locationId && c.id !== frame.triggeringCardId,
      );
      const respondCard = respondCardId ? state.cards.find((c) => c.id === respondCardId) : undefined;
      return (
        <div className="action-panel">
          <p className="hint">An alarm was triggered. Respond with one of your cards here, or pass.</p>
          <ul className="ability-list">
            {candidates.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setRespondCardId(c.id)}>
                  {c.defRef ?? "Hidden"} {respondCardId === c.id ? "(selected)" : ""}
                </button>
              </li>
            ))}
          </ul>
          {respondCard && respondCard.defRef && (
            <AbilityPicker card={respondCard} selectedIndex={respondAbilityIndex} onSelect={setRespondAbilityIndex} />
          )}
          <button
            type="button"
            disabled={!respondCardId || respondAbilityIndex === null}
            onClick={() =>
              onSubmit({
                type: "useResponse",
                cardId: respondCardId!,
                abilityIndex: respondAbilityIndex!,
                targetIds: [...selectedTargetIds],
              })
            }
          >
            Use Response
          </button>
          <button type="button" onClick={() => onSubmit({ type: "passResponse" })}>
            Pass
          </button>
        </div>
      );
    }
    case "protectedTargetingWindow": {
      const responder = frame.order[frame.nextIndex];
      if (responder !== humanPlayerId) return <p className="hint">Waiting…</p>;
      return (
        <div className="action-panel">
          <p className="hint">A Protected target was declared. Reveal any of your blended cards here at this location, or pass.</p>
          <button
            type="button"
            onClick={() => onSubmit({ type: "revealBlended", cardIds: [...selectedTargetIds] })}
          >
            Reveal Selected
          </button>
          <button type="button" onClick={() => onSubmit({ type: "passReveal" })}>
            Pass
          </button>
        </div>
      );
    }
    case "motorcadeInterceptionWindow": {
      const responder = frame.order[frame.nextIndex];
      if (responder !== humanPlayerId) return <p className="hint">Waiting…</p>;
      return (
        <div className="action-panel">
          <p className="hint">A Motorcade was played. Click an eligible card of yours to intercept it, or pass.</p>
          <button
            type="button"
            disabled={selectedTargetIds.size !== 1}
            onClick={() => onSubmit({ type: "interceptMotorcade", cardId: [...selectedTargetIds][0]! })}
          >
            Intercept
          </button>
          <button type="button" onClick={() => onSubmit({ type: "passIntercept" })}>
            Pass
          </button>
        </div>
      );
    }
    case "reactivePassiveWindow": {
      const responder = frame.order[frame.nextIndex];
      if (responder !== humanPlayerId) return <p className="hint">Waiting…</p>;
      return (
        <div className="action-panel">
          <p className="hint">Play any number of eligible hand cards here, or pass.</p>
          <button type="button" onClick={() => onSubmit({ type: "playReactive", cardIds: [...selectedTargetIds] })}>
            Play Selected
          </button>
          <button type="button" onClick={() => onSubmit({ type: "passReactive" })}>
            Pass
          </button>
        </div>
      );
    }
  }
}

async function toggleAndSubmitPresident(selectedTargetIds: Set<string>, onSubmit: (action: Action) => Promise<void>) {
  await onSubmit({ type: "chooseTargets", targetIds: [...new Set(selectedTargetIds).add(PRESIDENT_TARGET_ID)] });
}
