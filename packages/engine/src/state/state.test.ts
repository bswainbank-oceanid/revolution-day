import { describe, expect, it } from "vitest";
import { cardData } from "../data/cardData";
import { adjacentLocationIds, boardLayoutFromCardData } from "./board";
import { createRng, nextInt, shuffle } from "./rng";

describe("board layout", () => {
  it("builds a data-driven layout from card_data.json", () => {
    const board = boardLayoutFromCardData(cardData);
    expect(board).toHaveLength(6);
    expect(board.map((loc) => loc.type)).toEqual([
      "Street",
      "Secure",
      "Street",
      "Public",
      "Street",
      "Secure",
    ]);
  });

  it("computes adjacency as pure index math", () => {
    const board = boardLayoutFromCardData(cardData);
    expect(adjacentLocationIds(board, board[0]!.id)).toEqual([board[1]!.id]);
    expect(adjacentLocationIds(board, board[2]!.id)).toEqual([board[1]!.id, board[3]!.id]);
    expect(adjacentLocationIds(board, board[5]!.id)).toEqual([board[4]!.id]);
  });
});

describe("seeded RNG", () => {
  it("is deterministic for a given seed", () => {
    const a = nextInt(createRng(42), 100);
    const b = nextInt(createRng(42), 100);
    expect(a.value).toBe(b.value);
  });

  it("advances state rather than mutating a hidden generator", () => {
    const rng = createRng(1);
    const first = nextInt(rng, 100);
    const second = nextInt(first.rng, 100);
    expect(first.rng).not.toBe(rng);
    expect(second.rng).not.toBe(first.rng);
  });

  it("shuffle is a permutation and is deterministic per seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const a = shuffle(createRng(7), items);
    const b = shuffle(createRng(7), items);
    expect(a.items).toEqual(b.items);
    expect([...a.items].sort((x, y) => x - y)).toEqual(items);
  });
});
