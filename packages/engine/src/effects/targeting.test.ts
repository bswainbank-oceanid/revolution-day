import { describe, expect, it } from "vitest";
import { cardData } from "../data/cardData";
import { setupGame } from "../setup";
import type { CardInstance } from "../state/cards";
import type { GameState } from "../state/game";
import { isLegalEliminationTarget, isLegalPresidentTarget } from "./targeting";

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

  it("a face-down card's faction is invisible, so it doesn't count as a protector either", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    // Wife, face-down: "face-down cards do not count as regime or rebel
    // for targeting purposes" — her true Regime faction isn't usable here
    // until she's revealed. This is exactly what the protected-targeting
    // reveal window (not built yet at the isLegalEliminationTarget level)
    // exists to let other players do mid-declaration.
    const hiddenWife = card({
      id: "w",
      defRef: "Wife",
      kind: "leader",
      controller: "c",
      faceUp: false,
    });
    const s = { ...state, cards: [target, hiddenWife] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(true);
  });

  it("does count as a protector once that same card is revealed (Blend but not itself Protected)", () => {
    const state = baseState();
    const target = card({ id: "t", defRef: "Head of Security", kind: "leader", controller: "b" });
    // Secret Police: Regime + Blend, but no Protected attribute, so once
    // revealed it's a valid (non-Protected) protector — unlike Wife, whose
    // own Protected status would disqualify her per "protected doesn't
    // protect protected".
    const revealedSecretPolice = card({
      id: "s",
      defRef: "Secret Police",
      kind: "nonLeader",
      controller: "c",
      faceUp: true,
    });
    const s = { ...state, cards: [target, revealedSecretPolice] };
    expect(isLegalEliminationTarget(s, cardData, target, "a")).toBe(false);
  });
});

function withPresident(state: GameState, overrides: Partial<GameState["president"]>): GameState {
  return { ...state, president: { ...state.president, ...overrides } };
}

describe("isLegalPresidentTarget", () => {
  it("is never a legal target before he's entered the board", () => {
    const state = baseState();
    expect(isLegalPresidentTarget(state, cardData, "a", false)).toBe(false);
  });

  it("is never a legal target once already eliminated or survived", () => {
    const eliminated = withPresident(baseState(), { status: "eliminated", locationId: null });
    const survived = withPresident(baseState(), { status: "survived", locationId: null });
    expect(isLegalPresidentTarget(eliminated, cardData, "a", false)).toBe(false);
    expect(isLegalPresidentTarget(survived, cardData, "a", false)).toBe(false);
  });

  it("is eliminable when alive with no Regime protector at his location (3+ players)", () => {
    let state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-2" });
    expect(isLegalPresidentTarget(state, cardData, "a", false)).toBe(true);
  });

  it("is protected by another Regime card at his location", () => {
    let state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-2" });
    const guard = card({ id: "g", defRef: "Republican Guard", kind: "nonLeader", controller: "b", locationId: "loc-2" });
    state = { ...state, cards: [guard] };
    expect(isLegalPresidentTarget(state, cardData, "a", false)).toBe(false);
  });

  it("does not count the acting player's own Regime card as protection", () => {
    let state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-2" });
    const own = card({ id: "g", defRef: "Republican Guard", kind: "nonLeader", controller: "a", locationId: "loc-2" });
    state = { ...state, cards: [own] };
    expect(isLegalPresidentTarget(state, cardData, "a", false)).toBe(true);
  });

  it("ignoreProtection bypasses the guard check (Wife's ability)", () => {
    let state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-2" });
    const guard = card({ id: "g", defRef: "Republican Guard", kind: "nonLeader", controller: "b", locationId: "loc-2" });
    state = { ...state, cards: [guard] };
    expect(isLegalPresidentTarget(state, cardData, "a", true)).toBe(true);
  });

  it("is not eliminable before position 3 in a two-player game, even with ignoreProtection", () => {
    let state = setupGame({ playerIds: ["a", "b"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-1" }); // position 2
    expect(isLegalPresidentTarget(state, cardData, "a", true)).toBe(false);
  });

  it("is eliminable from position 3 onward in a two-player game", () => {
    let state = setupGame({ playerIds: ["a", "b"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-2" }); // position 3
    expect(isLegalPresidentTarget(state, cardData, "a", false)).toBe(true);
  });

  it("the two-player restriction does not apply with 3+ players", () => {
    let state = setupGame({ playerIds: ["a", "b", "c"], seed: 1, cardData });
    state = withPresident(state, { status: "alive", locationId: "loc-0" }); // position 1
    expect(isLegalPresidentTarget(state, cardData, "a", false)).toBe(true);
  });
});
