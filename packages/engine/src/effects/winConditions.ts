import { getFaction } from "../state/cardLookup";
import type { CardInstance } from "../state/cards";
import type { GameState, PlayerId } from "../state/game";
import type { CardData, Faction } from "../types";

// Declarative win-condition predicate DSL — same spirit as effects/dsl.ts,
// translating each leader's free-text win_conditions into structured,
// interpretable data (see data/winConditions.ts) rather than hand-coded
// per-leader branches. See rev_day_engine_design memory for the full
// worked-example derivation.
//
// `locationName` (not `locationId`) deliberately — a specific board
// position like "HQ"/"Palace" is only a stable *name*
// (BoardLayout[].name, set from card_data.json's locations_in_order), not
// a `loc-N` id, which is only assigned at setupGame time and isn't known
// when this data is authored.
export type WinPredicate =
  | { readonly type: "presidentStatus"; readonly value: "eliminated" | "notEliminated" }
  | { readonly type: "presidentEliminatedAt"; readonly locationName: string }
  | { readonly type: "survives" } // this leader's own card instance still not eliminated
  | { readonly type: "noOtherSurvivingLeaders" }
  | { readonly type: "factionMajority"; readonly locationName: string; readonly faction: Faction } // strictly greater
  | { readonly type: "locationSpread"; readonly faction: Faction; readonly minLocations: number }
  | { readonly type: "eliminatedByControlled"; readonly target: "president" | { readonly leaderCount: number } }
  | { readonly type: "metaNoFactionLeaderWins"; readonly faction: Faction }
  | { readonly type: "metaNoOtherPlayerWins" }
  // An explicit "or" *within* an otherwise-AND'd list — Master Assassin's
  // "Eliminate the President or 2 leaders with cards you control. Survive."
  // is (eliminatedByControlled:president OR eliminatedByControlled:2
  // leaders) AND survives; the "or" wraps just the first sentence, kept as
  // its own predicate slot rather than flattened.
  | { readonly type: "or"; readonly predicates: readonly WinPredicate[] };

// Pure query, not wired into the turn machine — per the design ("checked
// exactly once, when the game actually ends... not polled continuously"),
// the engine doesn't force the game to end; a caller decides when (the
// President survives past the last location, or
// GameState.turn.endgameTurnsRemaining reaches 0) and calls this then.
//
// Within one leader's predicate list, entries are AND'd — every sentence
// in the leader's card_data.json win_conditions text is a separate,
// simultaneously-required condition (corrected 2026-08-24; see
// rev_day_engine_design memory — the list was originally built as OR'd,
// which was wrong). An explicit "or" *inside* one sentence (Master
// Assassin) is represented by the `{type: "or"}` wrapper above, evaluated
// as a genuine OR among its own nested predicates. Meta-conditions
// (metaNoFactionLeaderWins/metaNoOtherPlayerWins) reference *other*
// players' resolved win status, so they're resolved via a small
// fixed-point loop (re-evaluate every player against the previous
// iteration's winner set until nothing changes, capped at
// players.length + 2 passes) rather than a hardcoded evaluation order —
// none of the current 8 leaders actually need more than 2 passes to
// converge, but a future leader set with real interdependencies won't
// silently break. Global override: if literally every player would win,
// nobody does ("if all players win, everyone loses").
export function evaluateWinConditions(
  state: GameState,
  cardData: CardData,
  winConditions: Readonly<Record<string, readonly WinPredicate[]>>,
): ReadonlySet<PlayerId> {
  const leaderOf = (playerId: PlayerId): CardInstance | undefined =>
    state.cards.find((c) => c.kind === "leader" && c.controller === playerId);

  // "Still in play," not merely "not eliminated" — a leader who never got
  // played (still sitting in `hand`) hasn't survived anything yet. In real
  // play this shouldn't arise at genuine game-end (an unplayed leader must
  // be played as the controller's first action once the President is
  // eliminated — a separate, not-yet-implemented forced-play rule), but
  // the predicate itself should still read `zone === "inPlay"` rather than
  // relying on that other rule having already run.
  const survives = (playerId: PlayerId): boolean => {
    const leader = leaderOf(playerId);
    return leader !== undefined && leader.zone === "inPlay";
  };

  const locationByName = (name: string): { id: string } => {
    const loc = state.board.find((l) => l.name === name);
    if (!loc) {
      throw new Error(`No location named "${name}" on this board`);
    }
    return loc;
  };

  // True affiliation at game end, per the ruling that Blend concealment
  // doesn't apply to end-of-game location tallies — reads getFaction
  // directly rather than gating on `faceUp`.
  const cardsAt = (locationId: string): CardInstance[] =>
    state.cards.filter((c) => c.zone === "inPlay" && c.locationId === locationId);

  const factionMajority = (locationName: string, faction: Faction): boolean => {
    const cards = cardsAt(locationByName(locationName).id);
    let matching = 0;
    let other = 0;
    for (const c of cards) {
      if (getFaction(cardData, c) === faction) matching++;
      else other++;
    }
    return matching > other;
  };

  const locationSpread = (faction: Faction, minLocations: number): boolean => {
    const locationIds = new Set<string>();
    for (const c of state.cards) {
      if (c.zone === "inPlay" && c.locationId && getFaction(cardData, c) === faction) {
        locationIds.add(c.locationId);
      }
    }
    return locationIds.size >= minLocations;
  };

  const eliminatedByControlled = (
    playerId: PlayerId,
    target: Extract<WinPredicate, { type: "eliminatedByControlled" }>["target"],
  ): boolean => {
    if (target === "president") {
      return state.president.status === "eliminated" && state.president.eliminatedByPlayerId === playerId;
    }
    const count = state.cards.filter(
      (c) => c.kind === "leader" && c.zone === "eliminated" && c.eliminatedByPlayerId === playerId,
    ).length;
    return count >= target.leaderCount;
  };

  // Handles every predicate shape, including the two that need to read
  // *other* players' resolved status (against `priorWinners`, the
  // previous fixed-point pass's snapshot — see below) and the "or"
  // wrapper (a genuine OR among its own nested predicates, evaluated
  // recursively through this same function).
  const evaluatePredicate = (
    playerId: PlayerId,
    predicate: WinPredicate,
    priorWinners: ReadonlySet<PlayerId>,
  ): boolean => {
    switch (predicate.type) {
      case "presidentStatus":
        return predicate.value === "eliminated"
          ? state.president.status === "eliminated"
          : state.president.status !== "eliminated";
      case "presidentEliminatedAt":
        return (
          state.president.status === "eliminated" &&
          state.president.eliminatedAtLocationId === locationByName(predicate.locationName).id
        );
      case "survives":
        return survives(playerId);
      case "noOtherSurvivingLeaders":
        return state.players.every((p) => p.id === playerId || !survives(p.id));
      case "factionMajority":
        return factionMajority(predicate.locationName, predicate.faction);
      case "locationSpread":
        return locationSpread(predicate.faction, predicate.minLocations);
      case "eliminatedByControlled":
        return eliminatedByControlled(playerId, predicate.target);
      case "metaNoFactionLeaderWins":
        return state.players.every((p) => {
          if (p.id === playerId) return true;
          const otherLeader = leaderOf(p.id);
          const otherFaction = otherLeader && getFaction(cardData, otherLeader);
          return otherFaction !== predicate.faction || !priorWinners.has(p.id);
        });
      case "metaNoOtherPlayerWins":
        return state.players.every((p) => p.id === playerId || !priorWinners.has(p.id));
      case "or":
        return predicate.predicates.some((p) => evaluatePredicate(playerId, p, priorWinners));
    }
  };

  // Each pass fully recomputes the winner set from scratch against the
  // *previous* pass's complete snapshot (not just incrementally adding to
  // it) — meta-conditions can retract a provisional winner as well as
  // grant one (a player who looked like a winner on a stale, too-early
  // snapshot can turn out not to be, once a same-pass rival is accounted
  // for), so a monotonic-only "add and never reconsider" loop would
  // converge to the wrong answer. Two consecutive identical snapshots is
  // the actual fixed point.
  let winners = new Set<PlayerId>();
  const maxIterations = state.players.length + 2;
  for (let i = 0; i < maxIterations; i++) {
    const priorWinners = winners;
    const nextWinners = new Set<PlayerId>();
    for (const player of state.players) {
      const leader = leaderOf(player.id);
      if (!leader) continue;
      const predicates = winConditions[leader.defRef] ?? [];
      // Every sentence (list entry) is a separate, simultaneously-required
      // condition — an empty list (a leader with no encoded conditions,
      // or one genuinely with none) vacuously never wins.
      const wins = predicates.length > 0 && predicates.every((predicate) => evaluatePredicate(player.id, predicate, priorWinners));
      if (wins) nextWinners.add(player.id);
    }
    const changed =
      nextWinners.size !== priorWinners.size || [...nextWinners].some((id) => !priorWinners.has(id));
    winners = nextWinners;
    if (!changed) break;
  }

  if (state.players.length > 0 && winners.size === state.players.length) {
    return new Set();
  }
  return winners;
}

// One player's outcome, broken down predicate by predicate — the "why"
// behind a win or loss. `predicates` mirrors the leader's own
// winConditions list shape 1:1 (including nested "or" predicates as a
// single entry, not expanded) so a caller can render it directly against
// the same data the leader's card text describes.
export interface PlayerWinOutcome {
  readonly playerId: PlayerId;
  readonly leaderDefRef: string | null;
  readonly won: boolean;
  readonly predicates: readonly { readonly predicate: WinPredicate; readonly satisfied: boolean }[];
}

export interface WinConditionExplanation {
  readonly winners: readonly PlayerId[];
  readonly losers: readonly PlayerId[];
  // True when every player's individual predicates were satisfied and the
  // "if all players win, everyone loses" override is what actually zeroed
  // the winner set — surfaced explicitly so a "why did nobody win" caller
  // isn't left looking at all-true predicates with no explanation.
  readonly allPlayersWouldWin: boolean;
  readonly outcomes: readonly PlayerWinOutcome[]; // one per player, seat order
}

// Same computation as evaluateWinConditions, but keeps the per-predicate
// results instead of collapsing straight to a winner set — built as a
// second entry point rather than folding into evaluateWinConditions
// itself so that function's existing signature/callers (its own tests,
// any code that only ever needed the plain winner set) don't have to
// change. Duplicates the fixed-point loop rather than sharing it with
// evaluateWinConditions: the two need different-shaped accumulators
// (Set<PlayerId> vs. a per-player predicate log) at each pass, and the
// loop body itself is short enough that threading a shared inner function
// through both wouldn't actually save much.
export function explainWinConditions(
  state: GameState,
  cardData: CardData,
  winConditions: Readonly<Record<string, readonly WinPredicate[]>>,
): WinConditionExplanation {
  const leaderOf = (playerId: PlayerId): CardInstance | undefined =>
    state.cards.find((c) => c.kind === "leader" && c.controller === playerId);
  const survives = (playerId: PlayerId): boolean => {
    const leader = leaderOf(playerId);
    return leader !== undefined && leader.zone === "inPlay";
  };
  const locationByName = (name: string): { id: string } => {
    const loc = state.board.find((l) => l.name === name);
    if (!loc) throw new Error(`No location named "${name}" on this board`);
    return loc;
  };
  const cardsAt = (locationId: string): CardInstance[] =>
    state.cards.filter((c) => c.zone === "inPlay" && c.locationId === locationId);
  const factionMajority = (locationName: string, faction: Faction): boolean => {
    const cards = cardsAt(locationByName(locationName).id);
    let matching = 0;
    let other = 0;
    for (const c of cards) {
      if (getFaction(cardData, c) === faction) matching++;
      else other++;
    }
    return matching > other;
  };
  const locationSpread = (faction: Faction, minLocations: number): boolean => {
    const locationIds = new Set<string>();
    for (const c of state.cards) {
      if (c.zone === "inPlay" && c.locationId && getFaction(cardData, c) === faction) locationIds.add(c.locationId);
    }
    return locationIds.size >= minLocations;
  };
  const eliminatedByControlled = (
    playerId: PlayerId,
    target: Extract<WinPredicate, { type: "eliminatedByControlled" }>["target"],
  ): boolean => {
    if (target === "president") {
      return state.president.status === "eliminated" && state.president.eliminatedByPlayerId === playerId;
    }
    const count = state.cards.filter(
      (c) => c.kind === "leader" && c.zone === "eliminated" && c.eliminatedByPlayerId === playerId,
    ).length;
    return count >= target.leaderCount;
  };
  const evaluatePredicate = (playerId: PlayerId, predicate: WinPredicate, priorWinners: ReadonlySet<PlayerId>): boolean => {
    switch (predicate.type) {
      case "presidentStatus":
        return predicate.value === "eliminated"
          ? state.president.status === "eliminated"
          : state.president.status !== "eliminated";
      case "presidentEliminatedAt":
        return (
          state.president.status === "eliminated" &&
          state.president.eliminatedAtLocationId === locationByName(predicate.locationName).id
        );
      case "survives":
        return survives(playerId);
      case "noOtherSurvivingLeaders":
        return state.players.every((p) => p.id === playerId || !survives(p.id));
      case "factionMajority":
        return factionMajority(predicate.locationName, predicate.faction);
      case "locationSpread":
        return locationSpread(predicate.faction, predicate.minLocations);
      case "eliminatedByControlled":
        return eliminatedByControlled(playerId, predicate.target);
      case "metaNoFactionLeaderWins":
        return state.players.every((p) => {
          if (p.id === playerId) return true;
          const otherLeader = leaderOf(p.id);
          const otherFaction = otherLeader && getFaction(cardData, otherLeader);
          return otherFaction !== predicate.faction || !priorWinners.has(p.id);
        });
      case "metaNoOtherPlayerWins":
        return state.players.every((p) => p.id === playerId || !priorWinners.has(p.id));
      case "or":
        return predicate.predicates.some((p) => evaluatePredicate(playerId, p, priorWinners));
    }
  };

  let winners = new Set<PlayerId>();
  const maxIterations = state.players.length + 2;
  for (let i = 0; i < maxIterations; i++) {
    const priorWinners = winners;
    const nextWinners = new Set<PlayerId>();
    for (const player of state.players) {
      const leader = leaderOf(player.id);
      if (!leader) continue;
      const predicates = winConditions[leader.defRef] ?? [];
      const wins = predicates.length > 0 && predicates.every((predicate) => evaluatePredicate(player.id, predicate, priorWinners));
      if (wins) nextWinners.add(player.id);
    }
    const changed = nextWinners.size !== priorWinners.size || [...nextWinners].some((id) => !priorWinners.has(id));
    winners = nextWinners;
    if (!changed) break;
  }

  // One final pass at the fixed point to capture per-predicate results —
  // meta-conditions read `winners` itself here, which is safe precisely
  // because the loop above only just stopped changing (i.e. re-evaluating
  // against `winners` reproduces `winners`).
  const outcomes: PlayerWinOutcome[] = state.players.map((player) => {
    const leader = leaderOf(player.id);
    const predicates = leader ? (winConditions[leader.defRef] ?? []) : [];
    return {
      playerId: player.id,
      leaderDefRef: leader?.defRef ?? null,
      won: winners.has(player.id),
      predicates: predicates.map((predicate) => ({
        predicate,
        satisfied: evaluatePredicate(player.id, predicate, winners),
      })),
    };
  });

  const allPlayersWouldWin = state.players.length > 0 && winners.size === state.players.length;
  const finalWinners = allPlayersWouldWin ? new Set<PlayerId>() : winners;

  return {
    winners: state.players.filter((p) => finalWinners.has(p.id)).map((p) => p.id),
    losers: state.players.filter((p) => !finalWinners.has(p.id)).map((p) => p.id),
    allPlayersWouldWin,
    outcomes: outcomes.map((o) => ({ ...o, won: finalWinners.has(o.playerId) })),
  };
}

// True once the game has reached one of its two end states — the
// President surviving past the last board location, or the post-
// elimination endgame countdown reaching 0 (see reducer.ts: set to
// 3 * players.length + 1 the moment he's eliminated, so every player,
// including whoever's turn is already in progress at that moment and
// gets to finish it uninterrupted, still gets exactly 3 full turns
// afterward before the game ends — the in-progress turn's own eventual
// endTurn consumes the "+1" without counting toward anyone's 3). A pure
// query, not polled by the engine itself; a caller (the server) checks
// this after every applied action, since either condition can become true
// mid-turn, not just at a turn boundary.
export function isGameOver(state: GameState): boolean {
  return state.president.status === "survived" || state.turn.endgameTurnsRemaining === 0;
}

// "All blended (face-down) characters are revealed at the end of the
// game" (additional_rulings, card_data.json) — evaluateWinConditions/
// explainWinConditions already read true affiliation internally
// regardless of faceUp, so this is purely about the *displayed* state
// once the game is over: a caller (the server) applies this once, at the
// moment isGameOver first becomes true, so a finished game's persisted
// state shows everyone's real identity rather than stale face-down cards.
export function revealAllBlendedCards(state: GameState): GameState {
  return {
    ...state,
    cards: state.cards.map((c) => (c.zone === "inPlay" && c.faceUp === false ? { ...c, faceUp: true } : c)),
  };
}
