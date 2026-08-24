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
  | { readonly type: "metaNoOtherPlayerWins" };

// Pure query, not wired into the turn machine — per the design ("checked
// exactly once, when the game actually ends... not polled continuously"),
// the engine doesn't force the game to end; a caller decides when (the
// President survives past the last location, or
// GameState.turn.endgameTurnsRemaining reaches 0) and calls this then.
//
// Within one leader's predicate list, entries are OR'd. Meta-conditions
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

  const evalDirectPredicate = (playerId: PlayerId, predicate: WinPredicate): boolean => {
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
      case "metaNoOtherPlayerWins":
        // Resolved in the fixed-point loop below, against the *previous*
        // iteration's winners — never true on a direct, single-pass read.
        return false;
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
      const wins = predicates.some((predicate) => {
        if (predicate.type === "metaNoFactionLeaderWins") {
          return state.players.every((p) => {
            if (p.id === player.id) return true;
            const otherLeader = leaderOf(p.id);
            const otherFaction = otherLeader && getFaction(cardData, otherLeader);
            return otherFaction !== predicate.faction || !priorWinners.has(p.id);
          });
        }
        if (predicate.type === "metaNoOtherPlayerWins") {
          return state.players.every((p) => p.id === player.id || !priorWinners.has(p.id));
        }
        return evalDirectPredicate(player.id, predicate);
      });
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
