import type { ReactNode } from "react";
import { cardData, getPassive, knownFaction } from "@rev-day/engine";
import type {
  Action,
  FilteredCardInstance,
  FilteredGameState,
  PlayerId,
  ResolutionFrame,
  RestrictedActionGrant,
} from "@rev-day/engine";
import { cardName, describeEntry, endgameTurnsLeftText, leaderEliminatedInEntry, locationName, presidentEliminatedInEntry } from "./gameText";
import { playerColorFor, playerLabel } from "./players";
import { usableActivateAbilities, usableResponseAbilities } from "./targetDecision";
import type { useTargetSelection } from "./useTargetSelection";
import type { LogEntry } from "./useGame";

// "+2 play-only (Rebel)", "Unlimited activate-only (Regime) here" —
// summarizes whichever repeatable grant (Puppet-Master, Master Assassin,
// Commander General, Opposition Leader — see RestrictedActionGrant) is
// currently active, so the player knows it exists once actionsRemaining
// alone no longer tells the whole story.
function describeGrant(grant: RestrictedActionGrant): string {
  const amount = grant.amount === "unbounded" ? "Unlimited" : `+${grant.amount}`;
  const verb = grant.kind === "play" ? "play" : "activate";
  const faction = grant.faction ? ` (${grant.faction})` : "";
  const where = grant.locationId ? " here" : "";
  return `${amount} ${verb}-only${faction}${where}`;
}

// Whoever's decision this particular frame is waiting on — same shape as
// decider() (client/decider.ts), just per-frame instead of only the top
// of the stack, since the whole point of the breadcrumb is showing every
// level at once.
function frameActorId(frame: ResolutionFrame): PlayerId {
  return frame.kind === "abilityResolution" ? frame.actingPlayerId : frame.order[frame.nextIndex]!;
}

// One breadcrumb line per resolution-stack frame — the Info section's own
// "current action stack". Deliberately terse (this is a small sidebar,
// not the Game Log): names the card where one's involved, and who the
// *next* decision in that frame belongs to.
function describeFrame(
  state: FilteredGameState,
  frame: ResolutionFrame,
  humanPlayerId: PlayerId,
  botPlayerIds: readonly PlayerId[],
  startingPlayerId: PlayerId,
): string {
  const who = (id: PlayerId) => (id === humanPlayerId ? "You" : playerLabel(state, id, humanPlayerId, botPlayerIds, startingPlayerId));
  const cardName = (id: string) => state.cards.find((c) => c.id === id)?.defRef ?? "a card";
  switch (frame.kind) {
    case "abilityResolution":
      return `${who(frame.actingPlayerId)} resolving ${cardName(frame.sourceCardId)}'s ability`;
    case "alarmResolution":
      return `Alarm (${cardName(frame.triggeringCardId)}) — awaiting ${who(frame.order[frame.nextIndex]!)}`;
    case "protectedTargetingWindow":
      return `Protected reveal — awaiting ${who(frame.order[frame.nextIndex]!)}`;
    case "motorcadeInterceptionWindow": {
      const at = locationName(state, frame.presidentLocationId);
      return `Motorcade${at ? ` (from ${at})` : ""} — awaiting ${who(frame.order[frame.nextIndex]!)}`;
    }
    case "reactivePassiveWindow":
      return `Reactive window (${cardName(frame.sourceCardId)}) — awaiting ${who(frame.order[frame.nextIndex]!)}`;
  }
}

interface ActivateAbilityBoxProps {
  readonly card: FilteredCardInstance | null;
  readonly state: FilteredGameState;
  readonly humanPlayerId: PlayerId;
  readonly botPlayerIds: readonly PlayerId[];
  // Whoever the engine's own random roll picked to go first this game —
  // needed to number every other player by turn order (see players.ts's
  // playerLabel), not raw seatIndex.
  readonly startingPlayerId: PlayerId;
  // For the action stack's "most recent action" fallback once the
  // resolution stack is empty — see describeFrame's own comment for the
  // stack-non-empty case.
  readonly log: readonly LogEntry[];
  // The pristine pre-game state — describeEntry needs the log's last
  // entry's *prior* state (e.g. the President's location before a
  // Motorcade moved him), and there's no log[-2] to fall back on when
  // there's only one entry so far.
  readonly initialState: FilteredGameState;
  readonly act: (action: Action) => void;
  readonly selection: ReturnType<typeof useTargetSelection>;
  // True while playback is narrating a beat that isn't the human's own to
  // keep acting through (an opponent's beat, or a turn-boundary reset —
  // see useTurnPlayback's own locksInteraction) — `state` here is the
  // currently-narrated intermediate state then, not the true pending
  // decision, so showing its resolutionStack-derived branches (Pass,
  // Done, ...) would be misleading even though they're disabled; this
  // takes over first. False for the human's own beats even while one is
  // technically still pacing in the background, so their own real
  // buttons stay live throughout their own turn. While true,
  // `playbackCaption` carries the "who/how targeted" text for whatever
  // the Card Viewer is currently showing.
  readonly isPlaying?: boolean;
  readonly playbackCaption?: string | null;
  // True while a previous action is still in flight — every button here
  // submits (or starts building toward) a real act() call, so without
  // this a rapid double-click could fire a second submission before the
  // first one's resulting state (and resolution-stack frame) has come
  // back, sending a stale action type against whatever frame the server
  // has since moved on to.
  readonly disabled?: boolean;
  // "Check Opponent's Turns" — see useTurnPlayback's own comments. A
  // persistent setting, not tied to any particular pending decision, so
  // it (and the Continue button it reveals) renders locked to the bottom
  // of the Info section regardless of which branch below is active.
  readonly checkOpponentTurns: boolean;
  readonly onCheckOpponentTurnsChange: (checked: boolean) => void;
  readonly awaitingContinue: boolean;
  readonly onContinue: () => void;
  // The current player, or whoever's responding/intercepting/reacting
  // mid-turn (App.tsx's own decider()/playbackActorId resolution) — the
  // whole box's base text color, matching the Game Log's own per-line
  // color-coding. The action stack's own breadcrumb overrides this per
  // line, since a nested frame can belong to a *different* player than
  // the one who opened it.
  readonly actionPlayerId: PlayerId;
  // The "Move" entry in the ability list — moveModeCardId is App.tsx's
  // own client-only pending state (non-null while CityView is showing
  // this card's adjacent locations as click targets, per the user's own
  // spec: select the card, click Move, choose a highlighted location or
  // click elsewhere to cancel). onStartMove begins it for the currently-
  // viewed card and switches to City View — this component only ever
  // reads moveModeCardId to know whether to show the button or a
  // "choose a location" hint instead.
  readonly moveModeCardId: string | null;
  readonly onStartMove: (cardId: string) => void;
  // Why the last submitted action was rejected (useGame.ts's own
  // actionError — a 400 from applyAction, an actual illegal move, not a
  // network/session problem) — takes over the action stack instead of
  // failing silently, until the next action attempt clears it.
  readonly actionError?: string | null;
}

// Two sections (per the user's own spec, merged down from an earlier
// 2x2 quadrant layout): Left is "Actions" — whatever's actually
// clickable about the pending decision (ability/response/intercept
// buttons and their explanatory heading/hints) on top, with turn-level
// flow (Draw/End Turn) anchored underneath it, always rendered
// regardless of what's pending. Right is "Info" — who's deciding and
// their remaining actions on top, the live action stack (the resolution
// stack as a breadcrumb, or just the most recent logged action once it's
// empty) below that, and Check Opponent's Turns locked to the very
// bottom, below everything else.
export function ActivateAbilityBox({
  card,
  state,
  humanPlayerId,
  botPlayerIds,
  startingPlayerId,
  log,
  initialState,
  act,
  selection,
  isPlaying,
  playbackCaption,
  disabled,
  checkOpponentTurns,
  onCheckOpponentTurnsChange,
  awaitingContinue,
  onContinue,
  actionPlayerId,
  moveModeCardId,
  onStartMove,
  actionError,
}: ActivateAbilityBoxProps) {
  const {
    cardPick,
    locationPick,
    respondingWith,
    startResponse,
    viewCardsMode,
    setViewCardsMode,
    unsupportedAbility,
    remoteAbilityPick,
    isPickingRemoteCard,
  } = selection;
  const topFrame = state.resolutionStack[state.resolutionStack.length - 1] ?? null;
  const actionColor = playerColorFor(state, actionPlayerId);

  const canTakeTurnAction = state.resolutionStack.length === 0 && state.turn.phase === "action";
  const deckCount = state.cards.filter((c) => c.zone === "deck").length;
  const canDraw = canTakeTurnAction && state.turn.actionsRemaining > 0 && deckCount > 0;
  const canEndTurn = canTakeTurnAction;

  // Once the President's elimination has started the endgame countdown,
  // and only on the human's own actual turn (not while narrating a bot's,
  // or an off-turn response/interception that merely happens to be
  // theirs) — see gameText.ts's own comment on why this needs no seat math.
  const turnsLeftText =
    actionPlayerId === humanPlayerId && state.turn.currentPlayerId === humanPlayerId ? endgameTurnsLeftText(state) : null;

  // Right, top: always visible — actions-remaining context doesn't
  // disappear just because a pick/alarm/intercept window opened on top
  // of it.
  const turnStatus = (
    <div className="activate-ability-status">
      <p className="current-player-label">{playerLabel(state, actionPlayerId, humanPlayerId, botPlayerIds, startingPlayerId)}</p>
      <div className="actions-remaining-row">
        <p className="actions-remaining-label">ACTIONS REMAINING</p>
        {/* Shares the label's own line instead of stacking below it — a
            separate line pushed this section's content past its fixed
            height (see .activate-ability-status's own comment), forcing
            it to scroll internally. */}
        {turnsLeftText && <span className="endgame-turns-left">{turnsLeftText}</span>}
      </div>
      <p className="actions-remaining-count">{state.turn.actionsRemaining}</p>
      {state.turn.restrictedAction && (
        <p className="hint restricted-play-actions">{describeGrant(state.turn.restrictedAction)}</p>
      )}
    </div>
  );

  // Left, bottom: "Your Turn Options" — Draw/End Turn are always
  // rendered (disabled via the same canDraw/canEndTurn either way), not
  // only in the default no-pending-decision branch, so this section's
  // contents never shift around.
  const turnFlowButtons = (
    <>
      <button type="button" className="flow-button" disabled={disabled || !canDraw} onClick={() => act({ type: "draw" })}>
        Draw
      </button>
      <button type="button" className="flow-button" disabled={disabled || !canEndTurn} onClick={() => act({ type: "endTurn" })}>
        End Turn
      </button>
    </>
  );

  // Right, bottom: locked to the very bottom of the Info section,
  // regardless of what's above it — a persistent viewing setting, not
  // tied to any particular pending decision.
  const checkOpponentsTurnsBlock = (
    <div className="check-opponent-turns">
      <label className="check-opponent-turns-label">
        <input type="checkbox" checked={checkOpponentTurns} onChange={(e) => onCheckOpponentTurnsChange(e.target.checked)} />
        Check Opponent's Turns
      </label>
      {checkOpponentTurns && (
        <button type="button" className="flow-button" disabled={!awaitingContinue} onClick={onContinue}>
          Continue
        </button>
      )}
    </div>
  );

  // Right, middle: the live resolution stack as a color-coded breadcrumb —
  // each line can belong to a *different* player than whoever opened the
  // outer frame (e.g. you activate an ability, an opponent's alarm
  // response is now what's actually pending), so each line sets its own
  // color rather than inheriting the box's own actionColor. Falls back to
  // just the single most recent logged action once the stack is empty.
  // actionError takes over ahead of all of that — the state didn't
  // actually advance (the attempted action was rejected), so whatever
  // would otherwise show here is still exactly accurate, but explaining
  // the rejection is the more urgent thing to say right now.
  let actionStack: ReactNode;
  if (actionError) {
    actionStack = <p className="hint action-error">{actionError}</p>;
  } else if (isPlaying) {
    actionStack = <p className="hint">{playbackCaption ?? "Watching the turn play out…"}</p>;
  } else if (state.resolutionStack.length > 0) {
    actionStack = (
      <ul className="action-log-stack">
        {state.resolutionStack.map((frame, i) => (
          <li key={i} style={{ color: playerColorFor(state, frameActorId(frame)) }}>
            {describeFrame(state, frame, humanPlayerId, botPlayerIds, startingPlayerId)}
          </li>
        ))}
      </ul>
    );
  } else {
    const lastEntry = log[log.length - 1];
    const priorState = log.length > 1 ? log[log.length - 2]!.resultingState : initialState;
    const presidentDown = lastEntry ? presidentEliminatedInEntry(priorState, lastEntry.resultingState) : false;
    const leaderDown = lastEntry && !presidentDown ? leaderEliminatedInEntry(priorState, lastEntry.resultingState) : false;
    const specialClass = presidentDown ? "president-eliminated-line" : leaderDown ? "leader-eliminated-line" : null;
    actionStack = lastEntry ? (
      <p
        className={specialClass ? `hint ${specialClass}` : "hint"}
        style={specialClass ? undefined : { color: playerColorFor(lastEntry.resultingState, lastEntry.actingPlayerId) }}
      >
        {describeEntry(lastEntry, priorState, humanPlayerId, botPlayerIds, startingPlayerId)}
      </p>
    ) : (
      <p className="hint">No actions yet.</p>
    );
  }

  // Left, top: the pending decision's own heading/hints and every
  // card-specific button (ability/response/intercept/target-mode/Done) —
  // everything except the turn-level Draw/End Turn, which sit underneath
  // it instead (turnFlowButtons above).
  let abilityActions: ReactNode;

  if (isPlaying) {
    abilityActions = <p className="hint">Watching the turn play out…</p>;
  } else if (unsupportedAbility) {
    abilityActions = <p className="hint">This ability isn't supported by the client yet.</p>;
  } else if (remoteAbilityPick) {
    abilityActions = (
      <>
        <h3>CHOOSE AN ABILITY</h3>
        <p className="hint">Activating {cardName(state, remoteAbilityPick.card.id)}'s ability:</p>
        {remoteAbilityPick.abilities.length === 0 ? (
          <p className="hint">No usable ability on this card right now.</p>
        ) : (
          remoteAbilityPick.abilities.map((a) => (
            <button
              key={a.abilityIndex}
              type="button"
              className="ability-button"
              disabled={disabled}
              onClick={() => remoteAbilityPick.choose(a.abilityIndex)}
            >
              {a.text}
            </button>
          ))
        )}
        <button type="button" className="flow-button" disabled={disabled} onClick={remoteAbilityPick.cancel}>
          Choose a different card
        </button>
      </>
    );
  } else if (cardPick || locationPick) {
    const selectedCount = cardPick?.selectedIds.length ?? 0;
    abilityActions = (
      <>
        <h3>{respondingWith ? "RESPOND" : isPickingRemoteCard ? "CHOOSE A CARD TO ACTIVATE" : "CHOOSE TARGETS"}</h3>
        {cardPick && (
          <>
            <p className="hint">
              {selectedCount} selected · {cardPick.candidates.length} eligible
            </p>
            <div className="target-mode-toggle">
              <button type="button" className={viewCardsMode ? "" : "active"} onClick={() => setViewCardsMode(false)}>
                Choose Targets
              </button>
              <button type="button" className={viewCardsMode ? "active" : ""} onClick={() => setViewCardsMode(true)}>
                View Cards
              </button>
            </div>
            {cardPick.done && (
              <button type="button" className="flow-button" disabled={disabled} onClick={cardPick.done}>
                Done
              </button>
            )}
          </>
        )}
        {locationPick && <p className="hint">Click a highlighted location.</p>}
      </>
    );
  } else if (topFrame?.kind === "alarmResolution" && !respondingWith) {
    const responses = card && card.controller === humanPlayerId ? usableResponseAbilities(state, card, topFrame.triggeringCardId, topFrame.locationId, humanPlayerId) : [];
    abilityActions = (
      <>
        <h3>RESPOND</h3>
        <p className="hint">Respond, or pass.</p>
        <button type="button" className="flow-button" disabled={disabled} onClick={() => act({ type: "passResponse" })}>
          Pass
        </button>
        {card && card.controller === humanPlayerId ? (
          responses.length === 0 ? (
            <p className="hint">No Response ability available on this card.</p>
          ) : (
            responses.map((r) => (
              <button
                key={r.abilityIndex}
                type="button"
                className="ability-button"
                disabled={disabled}
                onClick={() => startResponse(card.id, r.abilityIndex)}
              >
                {r.text}
              </button>
            ))
          )
        ) : (
          <p className="hint">Select one of your own cards to respond, or pass.</p>
        )}
      </>
    );
  } else if (topFrame?.kind === "motorcadeInterceptionWindow") {
    const eligible =
      !!card &&
      card.controller === humanPlayerId &&
      card.zone === "inPlay" &&
      card.locationId === topFrame.presidentLocationId &&
      card.defRef !== null &&
      getPassive(card.defRef)?.kind === "motorcadeInterception";
    abilityActions = (
      <>
        <h3>INTERCEPT MOTORCADE</h3>
        <p className="hint">Intercept, or let it through.</p>
        <button type="button" className="flow-button" disabled={disabled} onClick={() => act({ type: "passIntercept" })}>
          Pass
        </button>
        {eligible ? (
          <button
            type="button"
            className="ability-button"
            disabled={disabled}
            onClick={() => act({ type: "interceptMotorcade", cardId: card!.id })}
          >
            Intercept — eliminate {card!.defRef}
          </button>
        ) : (
          <p className="hint">This card cannot intercept the Motorcade.</p>
        )}
      </>
    );
  } else {
    // Default: nothing pending — show the currently-viewed card's
    // abilities, if any.
    const activateGrant = state.turn.restrictedAction?.kind === "activate" ? state.turn.restrictedAction : null;
    const cardQualifiesForActivateGrant =
      !!card &&
      activateGrant !== null &&
      (activateGrant.amount === "unbounded" || activateGrant.amount > 0) &&
      (activateGrant.faction === null || knownFaction(cardData, card) === activateGrant.faction) &&
      (activateGrant.locationId === null || card.locationId === activateGrant.locationId);
    const canActivate =
      canTakeTurnAction && (state.turn.actionsRemaining > 0 || cardQualifiesForActivateGrant);
    const isOwnCard = !!card && card.controller === humanPlayerId && card.zone === "inPlay";
    const abilities = card && isOwnCard && canActivate ? usableActivateAbilities(state, card, state.turn.usedAbilities, humanPlayerId) : [];
    // Move spends the normal turn budget only — no restricted grant ever
    // pays for it (see App.tsx's own comment on cardQualifiesForPlayGrant),
    // so this doesn't need the activate-grant carve-out canActivate has.
    const canMove = !!card && card.defRef !== null && isOwnCard && canTakeTurnAction && state.turn.actionsRemaining > 0;
    const isMovingThisCard = !!card && moveModeCardId === card.id;
    const hasAnyOption = abilities.length > 0 || canMove;

    abilityActions = (
      <>
        {hasAnyOption && <h3>ACTIVATE ABILITY</h3>}
        {isMovingThisCard ? (
          <p className="hint">Choose a highlighted location, or click elsewhere to cancel.</p>
        ) : !card || card.defRef === null ? (
          <p className="hint">No abilities</p>
        ) : !hasAnyOption ? (
          <p className="hint">No abilities{card.defRef === "President" ? " — Protected" : ""}</p>
        ) : (
          <>
            {abilities.map((a) => (
              <button
                key={a.abilityIndex}
                type="button"
                className="ability-button"
                disabled={disabled}
                onClick={() => act({ type: "activateAbility", cardId: card.id, abilityIndex: a.abilityIndex })}
              >
                {a.text}
              </button>
            ))}
            {canMove && (
              <button type="button" className="ability-button" disabled={disabled} onClick={() => onStartMove(card.id)}>
                Move
              </button>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <div className="activate-ability-box" style={{ color: actionColor }}>
      <div className="activate-ability-left">
        <div className="activate-ability-actions">{abilityActions}</div>
        <div className="activate-ability-turn-flow">{turnFlowButtons}</div>
      </div>
      <div className="activate-ability-right">
        {turnStatus}
        <div className="activate-ability-stack">{actionStack}</div>
        {checkOpponentsTurnsBlock}
      </div>
    </div>
  );
}
