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
}

export function setupGame(options: SetupOptions): GameState {
  const { playerIds, seed, cardData } = options;
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
    Array.from({ length: card.copies }, () => ({
      id: newId("card"),
      defRef: card.name,
      kind: "nonLeader" as const,
      zone: "deck" as const,
      controller: null,
    })),
  );

  const motorcadeInstances: CardInstance[] = Array.from(
    { length: cardData.motorcade.count_in_deck },
    () => ({
      id: newId("motorcade"),
      defRef: cardData.motorcade.name,
      kind: "motorcade" as const,
      zone: "deck" as const,
      controller: null,
    }),
  );

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
      restrictedPlayActions: 0,
      endgameTurnsRemaining: null,
      usedAbilities: [],
    },
    resolutionStack: [],
    pendingPassiveQueue: [],
  };
}
