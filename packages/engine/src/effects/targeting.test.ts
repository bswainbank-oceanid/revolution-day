import { describe, expect, it } from "vitest";
import { cardData } from "../data/cardData";
import { setupGame } from "../setup";
import type { CardInstance } from "../state/cards";
import type { GameState } from "../state/game";
import { isLegalEliminationTarget } from "./targeting";

function baseState(): GameState {
  return setupGame({ playerIds: ["a", "b"], seed: 1, cardData });
}

function card(
  overrides: Partial<CardInstance> & Pick<CardInstance, "id" | "defRef" | "kind">,
): CardInstance {
  return { zone: "inPlay", controller: "a", locationId: "loc-0", faceUp: true, ...overrides };
}

describe("isLegalEliminationTarget", () => {
  it("is eliminable when no other same-faction card is at the location", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    const s = { ...state, cards: [target] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(true);
  });

  it("is protected by another same-faction, non-Protected card at the location", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    const protector = card({ id: "p", defRef: "Republican Guard", kind: "nonLeader", controller: "c" });
    const s = { ...state, cards: [target, protector] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(false);
  });

  it("does not count cards the acting player controls toward protection", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    const ownCard = card({ id: "o", defRef: "Republican Guard", kind: "nonLeader", controller: "a" });
    const s = { ...state, cards: [target, ownCard] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(true);
  });

  it("is not protected by another Protected character — only an active non-Protected one counts", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    const otherProtected = card({ id: "o", defRef: "Commander General", kind: "leader", controller: "c" });
    const s = { ...state, cards: [target, otherProtected] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(true);
  });

  it("ignores faction from a different location", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    const elsewhere = card({
      id: "e",
      defRef: "Republican Guard",
      kind: "nonLeader",
      controller: "c",
      locationId: "loc-1",
    });
    const s = { ...state, cards: [target, elsewhere] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(true);
  });

  it("gets no protection benefit while blended, even with a protector present", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Wife", kind: "leader", controller: "b", faceUp: false });
    const protector = card({ id: "p", defRef: "Bodyguard", kind: "nonLeader", controller: "c" });
    const s = { ...state, cards: [target, protector] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(true);
  });

  it("is protected once revealed, same as any other Protected character", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Wife", kind: "leader", controller: "b", faceUp: true });
    const protector = card({ id: "p", defRef: "Bodyguard", kind: "nonLeader", controller: "c" });
    const s = { ...state, cards: [target, protector] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(false);
  });

  it("a face-down Protected+Blend card still counts as a protector for others (not 'active' Protected)", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    // Wife, face-down, is Regime + not currently Protected-active — should
    // still count as a valid (non-Protected) protector for Head of Security.
    const hiddenWife = card({
      id: "w",
      defRef: "Wife",
      kind: "leader",
      controller: "c",
      faceUp: false,
    });
    const s = { ...state, cards: [target, hiddenWife] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(false);
  });
});
