import { describe, expect, it } from "vitest";
import { cardData } from "../data/cardData";
import { setupGame } from "../setup";
import type { GameState, PlayerId } from "../state/game";
import { filterForPlayer } from "./filterForPlayer";

function baseState(): GameState {
  return setupGame({ playerIds: ["a", "b"], seed: 1, cardData });
}

function place(state: GameState, cardId: string, locationId: string, controller: PlayerId, faceUp: boolean): GameState {
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === cardId ? { ...c, zone: "inPlay" as const, locationId, controller, faceUp } : c)),
  };
}

describe("filterForPlayer", () => {
  it("omits the RNG seed entirely", () => {
    const state = baseState();
    const filtered = filterForPlayer(state, "a");
    expect(filtered).not.toHaveProperty("rng");
  });

  it("hides another player's hand cards, but not the viewer's own", () => {
    const state = baseState();
    const filtered = filterForPlayer(state, "a");

    const ownHandCard = filtered.cards.find((c) => c.zone === "hand" && c.controller === "a")!;
    const otherHandCard = filtered.cards.find((c) => c.zone === "hand" && c.controller === "b")!;

    expect(ownHandCard.defRef).not.toBeNull();
    expect(otherHandCard.defRef).toBeNull();
  });

  it("hides deck cards from everyone", () => {
    const state = baseState();
    const filtered = filterForPlayer(state, "a");
    const deckCards = filtered.cards.filter((c) => c.zone === "deck");
    expect(deckCards.length).toBeGreaterThan(0);
    expect(deckCards.every((c) => c.defRef === null)).toBe(true);
  });

  it("hides a face-down in-play card controlled by someone else, but reveals your own", () => {
    let state = baseState();
    const loc = state.board[0]!.id;
    const [cardA, cardB] = state.cards.filter((c) => c.kind === "nonLeader");
    state = place(state, cardA!.id, loc, "a", false);
    state = place(state, cardB!.id, loc, "b", false);

    const filtered = filterForPlayer(state, "a");

    expect(filtered.cards.find((c) => c.id === cardA!.id)!.defRef).not.toBeNull(); // own, hidden or not
    expect(filtered.cards.find((c) => c.id === cardB!.id)!.defRef).toBeNull(); // theirs, face-down
  });

  it("reveals a face-up in-play card regardless of controller", () => {
    let state = baseState();
    const loc = state.board[0]!.id;
    const card = state.cards.find((c) => c.kind === "nonLeader")!;
    state = place(state, card.id, loc, "b", true);

    const filtered = filterForPlayer(state, "a");

    expect(filtered.cards.find((c) => c.id === card.id)!.defRef).not.toBeNull();
  });

  it("preserves structural fields (kind, zone, controller, locationId) even when hidden", () => {
    let state = baseState();
    const loc = state.board[0]!.id;
    const card = state.cards.find((c) => c.kind === "nonLeader")!;
    state = place(state, card.id, loc, "b", false);

    const filtered = filterForPlayer(state, "a");
    const hidden = filtered.cards.find((c) => c.id === card.id)!;

    expect(hidden.defRef).toBeNull();
    expect(hidden.kind).toBe("nonLeader");
    expect(hidden.zone).toBe("inPlay");
    expect(hidden.controller).toBe("b");
    expect(hidden.locationId).toBe(loc);
    expect(hidden.faceUp).toBe(false);
  });
});
