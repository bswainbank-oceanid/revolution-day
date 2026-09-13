import type { CardData } from "./types";
import { boardLayoutFromCardData } from "./state/board";
import type { CardInstance } from "./state/cards";
import type { GameState, Player, PlayerId } from "./state/game";
import { createRng, nextInt, shuffle, type RngState } from "./state/rng";

// Setup procedure per the rulebook (page 2 "Setup"), not inferred: extract
// and shuffle the 8 leaders, deal one per player secretly (the rest are
// set aside, never entering the draw deck), shuffle everything else into
// the draw deck, deal 4 more cards per player for a 5-card opening hand
// (skipped at 6+ players — no draw up to 5, per the existing ruling), then
// randomly determine the starting player.
export interface SetupOptions {
  readonly playerIds: readonly PlayerId[];
  readonly seed: number;
  readonly cardData: CardData;
  // A full duplicate set of non-leader cards (every non_leader_cards entry's
  // own `copies` doubled) for a longer game with more players — but only 5
  // additional Motorcade cards, not a full second set of 9 (per request:
  // "5 additional motorcade cards will be added instead of 9"), so the
  // Motorcade total is 14, not 18. Leaders are untouched either way — still
  // exactly one dealt per player from the fixed set of 8.
  readonly secondDeck?: boolean;
}

export function setupGame(options: SetupOptions): GameState {
  const { playerIds, seed, cardData, secondDeck = false } = options;
  if (playerIds.length < 2 || playerIds.length > 8) {
    throw new Error(`Revolution Day supports 2-8 players, got ${playerIds.length}`);
  }

  let rng: RngState = createRng(seed);
  const board = boardLayoutFromCardData(cardData);

  let nextInstanceId = 0;
  const newId = (prefix: string): string => `${prefix}-${nextInstanceId++}`;

  const leaderShuffle = shuffle(rng, cardData.leaders);
  rng = leaderShuffle.rng;
  const dealtLeaders = leaderShuffle.items.slice(0, playerIds.length);
  const leaderInstances: CardInstance[] = dealtLeaders.map((leader, i) => ({
    id: newId("leader"),
    defRef: leader.name,
    kind: "leader",
    zone: "hand",
    controller: playerIds[i]!,
  }));

  const nonLeaderInstances: CardInstance[] = cardData.non_leader_cards.flatMap((card) =>
    Array.from({ length: secondDeck ? card.copies * 2 : card.copies }, () => ({
      id: newId("card"),
      defRef: card.name,
      kind: "nonLeader" as const,
      zone: "deck" as const,
      controller: null,
    })),
  );

  const motorcadeCount = cardData.motorcade.count_in_deck + (secondDeck ? 5 : 0);
  const motorcadeInstances: CardInstance[] = Array.from({ length: motorcadeCount }, () => ({
    id: newId("motorcade"),
    defRef: cardData.motorcade.name,
    kind: "motorcade" as const,
    zone: "deck" as const,
    controller: null,
  }));

  const deckShuffle = shuffle(rng, [...nonLeaderInstances, ...motorcadeInstances]);
  rng = deckShuffle.rng;
  const shuffledDeck = deckShuffle.items;

  const dealtHandCards: CardInstance[] = [];
  let deckIndex = 0;
  if (playerIds.length < 6) {
    for (const playerId of playerIds) {
      for (let i = 0; i < 4 && deckIndex < shuffledDeck.length; i++) {
        const card = shuffledDeck[deckIndex]!;
        dealtHandCards.push({ ...card, zone: "hand", controller: playerId });
        deckIndex++;
      }
    }
  }
  const remainingDeck = shuffledDeck.slice(deckIndex);

  const startRoll = nextInt(rng, playerIds.length);
  rng = startRoll.rng;
  const startingPlayerId = playerIds[startRoll.value]!;

  return {
    rng,
    board,
    players: playerIds.map((id, seatIndex): Player => ({ id, seatIndex, hasTakenFirstTurn: false })),
    cards: [...leaderInstances, ...dealtHandCards, ...remainingDeck],
    president: { status: "notEntered", locationId: null },
    turn: {
      currentPlayerId: startingPlayerId,
      phase: "draw",
      actionsRemaining: 2,
      restrictedAction: null,
      endgameTurnsRemaining: null,
      usedAbilities: [],
    },
    resolutionStack: [],
    pendingPassiveQueue: [],
  };
}
