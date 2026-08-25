import { cardData, filterForPlayer, setupGame } from "@rev-day/engine";
import type { AbilityResolutionFrame, AlarmResolutionFrame, CardInstance, GameState, PlayerId } from "@rev-day/engine";
import { describe, expect, it } from "vitest";
import { decideBotAction } from "./decide";
import type { Rng } from "./random";

function freshGame(playerIds: readonly string[] = ["a", "b", "c"], seed = 1): GameState {
  return setupGame({ playerIds, seed, cardData });
}

function place(state: GameState, cardId: string, locationId: string, controller: PlayerId, faceUp = true): GameState {
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === cardId ? { ...c, zone: "inPlay" as const, locationId, controller, faceUp } : c)),
  };
}

function findByDefRef(state: GameState, defRef: string): CardInstance {
  return state.cards.find((c) => c.defRef === defRef)!;
}

const zero: Rng = () => 0;
const near1: Rng = () => 0.999;

describe("decideBotAction: top-level turn actions", () => {
  it("issues the mandatory draw when phase is 'draw'", () => {
    const state = freshGame();
    const player = state.turn.currentPlayerId;
    const filtered = filterForPlayer(state, player);

    expect(decideBotAction(filtered, player, cardData, zero)).toEqual({ type: "draw" });
  });

  it("ends the turn once no budgeted actions remain", () => {
    let state = freshGame();
    const player = state.turn.currentPlayerId;
    state = { ...state, turn: { ...state.turn, phase: "action", actionsRemaining: 0 } };
    const filtered = filterForPlayer(state, player);

    expect(decideBotAction(filtered, player, cardData, zero)).toEqual({ type: "endTurn" });
  });

  it("picks 'playCard' first in the weighted category order (rng=0)", () => {
    let state = freshGame();
    state = { ...state, turn: { ...state.turn, phase: "action" } };
    const player = state.turn.currentPlayerId;
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(["playCard", "playMotorcade", "endTurn"]).toContain(action.type); // depends on what's in hand
  });
});

describe("decideBotAction: eliminate targeting", () => {
  it("prefers an opposing card over the acting player's own when both are eligible", () => {
    let state = freshGame(["a", "b", "c"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const guard = findByDefRef(state, "Republican Guard");
    const loc = state.board.find((l) => l.type === "Secure")!.id;
    const ownTarget = state.cards.filter((c) => c.defRef === "Prominent Citizen")[0]!;
    const opposingTarget = state.cards.filter((c) => c.defRef === "Prominent Citizen")[1]!;
    state = place(state, guard.id, loc, player);
    state = place(state, ownTarget.id, loc, player);
    state = place(state, opposingTarget.id, loc, other);
    state = { ...state, turn: { ...state.turn, phase: "action" } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: guard.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toMatchObject({ type: "chooseTargets" });
      const targetIds = (action as { targetIds: readonly string[] }).targetIds;
      expect(targetIds).toEqual([opposingTarget.id]);
    }
  });

  // Regression: eliminate targeting used to fall back to the acting
  // player's own cards when no opposing candidate existed ("no opposing
  // candidate exists — fall back to whatever's legal") — the user
  // corrected this: never eliminate your own cards, full stop, not even
  // as a last resort. A real game showed the consequence (a bot
  // eliminating its own leader). Covers both layers: the top-level choice
  // to activate at all (abilityHasAvailableFirstTarget), and the actual
  // target selection once activated (decideEliminateTargetIds).
  it("never activates an eliminate ability when only its own cards are eligible targets", () => {
    let state = freshGame(["a", "b", "c"]);
    const guard = findByDefRef(state, "Republican Guard");
    const player = state.turn.currentPlayerId;
    const loc = state.board.find((l) => l.type === "Secure")!.id;
    const ownOnlyTarget = state.cards.filter((c) => c.defRef === "Prominent Citizen")[0]!;
    state = place(state, guard.id, loc, player);
    state = place(state, ownOnlyTarget.id, loc, player); // only own-controlled candidate at this location
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const forceActivateAbility: Rng = () => 0.8; // see the Traffic Cop/Wife tests below for why
    const action = decideBotAction(filtered, player, cardData, forceActivateAbility);
    expect(action).toEqual({ type: "endTurn" });
  });

  it("Wife always targets the President (the only candidate her ability offers)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Wife guaranteed dealt
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = place(state, wife.id, loc, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    state = { ...state, president: { status: "alive", locationId: state.board[2]!.id } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: wife.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: ["president"] });
  });
});

describe("decideBotAction: prefers eliminate-capable options", () => {
  it("Master Assassin never picks its non-eliminate ability (index 0) when choosing which to activate", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const assassin = findByDefRef(state, "Master Assassin");
    const player = assassin.controller ?? state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = place(state, assassin.id, loc, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      if (action.type === "activateAbility" && action.cardId === assassin.id) {
        expect(action.abilityIndex).not.toBe(0); // 0 = returnToHand+play, the only non-eliminate Activate ability
      }
    }
  });

  it("prefers using an eliminate-capable Response during an alarm over passing", () => {
    let state = freshGame(["a", "b", "c"]);
    const gunman = findByDefRef(state, "Gunman");
    const assassin = state.cards.filter((c) => c.defRef === "Assassin")[0]!;
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    state = place(state, gunman.id, loc, player, false);
    state = place(state, assassin.id, loc, other);
    const target = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, target.id, loc, player);

    const frame: AlarmResolutionFrame = {
      kind: "alarmResolution",
      triggeringCardId: gunman.id,
      triggeringPlayerId: player,
      locationId: loc,
      order: [other, player],
      nextIndex: 0,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, other);

    const action = decideBotAction(filtered, other, cardData, zero);
    expect(action.type).toBe("useResponse");
  });
});

describe("decideBotAction: avoids abilities with no legal way to complete", () => {
  // Regression: Traffic Cop's move effect has no legal "decline" once
  // activated (unlike every resolution-stack window) — activating it when
  // the President isn't even at its location, or hasn't entered the board
  // at all, left a real bot permanently stuck in a live game. Same root
  // cause as Head of Security's activateRemote with an empty candidate
  // pool — abilityHasAvailableFirstTarget must catch both.
  //
  // pickWeighted's ["activateAbility", 20] band sits at roll 70-90 out of
  // 100 (after playCard 0-40 and draw 40-70) — rng()=0.8 lands there
  // deterministically; with only Traffic Cop in play, every subsequent
  // pickRandom/pickN call also resolves deterministically off a pool of 1.
  const forceActivateAbility: Rng = () => 0.8;

  it("never activates Traffic Cop's move ability when the President isn't at its location", () => {
    let state = freshGame(["a", "b", "c"]);
    const trafficCop = findByDefRef(state, "Traffic Cop");
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = place(state, trafficCop.id, loc, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    // President never entered the board — status "notEntered" — so Traffic
    // Cop's "move him from this location" can never be legally completed.
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, forceActivateAbility);
    // Traffic Cop is the only card in play, so if its ability were wrongly
    // deemed usable it would be the one chosen; excluded, nothing is left.
    expect(action).toEqual({ type: "endTurn" });
  });

  it("does activate Traffic Cop when the President is actually at its location", () => {
    let state = freshGame(["a", "b", "c"]);
    const trafficCop = findByDefRef(state, "Traffic Cop");
    const player = state.turn.currentPlayerId;
    const loc = state.board[2]!.id; // an interior location, so both neighbors exist
    state = place(state, trafficCop.id, loc, player);
    state = { ...state, president: { status: "alive", locationId: loc } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, forceActivateAbility);
    expect(action).toMatchObject({ type: "activateAbility", cardId: trafficCop.id });
  });

  // Regression: Wife's eliminate-the-President ability assumed the
  // President sentinel is always a legal candidate once his status isn't
  // "alive" — true for "eliminated"/"notEntered", but also for
  // "survived" (the endgame state once he's outlasted the board), which a
  // real bot hit and got stuck on the exact same way as the two cases
  // above.
  it("never activates Wife's ability once the President has 'survived' (endgame, no longer targetable)", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = place(state, wife.id, loc, player);
    state = { ...state, president: { status: "survived", locationId: null } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, forceActivateAbility);
    expect(action).toEqual({ type: "endTurn" });
  });

  it("does activate Wife's ability while she's at the President's location", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = place(state, wife.id, loc, player);
    state = { ...state, president: { status: "alive", locationId: loc } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, forceActivateAbility);
    expect(action).toMatchObject({ type: "activateAbility", cardId: wife.id });
  });

  // Regression: activateRemote (Head of Security) picked a target card +
  // one of its Activate abilities without checking whether *that* ability
  // has any legal first target — a real bot got permanently stuck
  // remotely activating Death Squad's "eliminate 1 or 2 at this location"
  // when Death Squad was the only card at its location.
  it("never remotely activates an ability with no legal target at the remote card's own location", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Head of Security guaranteed dealt
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller ?? state.turn.currentPlayerId;
    const hosLoc = state.board[0]!.id;
    const deathSquad = findByDefRef(state, "Death Squad");
    const aloneLoc = state.board[1]!.id;
    state = place(state, hos.id, hosLoc, player);
    state = place(state, deathSquad.id, aloneLoc, state.players.find((p) => p.id !== player)!.id);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: hos.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: hosLoc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toMatchObject({ type: "chooseTargets" });
      const targetIds = (action as { targetIds: readonly string[] }).targetIds;
      expect(targetIds).not.toContain(deathSquad.id);
    }
  });

  // Regression: abilityHasAvailableFirstTarget's "never eliminate own
  // cards" pool filter (see the earlier own-cards test) checked
  // sourceCard.controller — correct for a direct activateAbility (the
  // card's controller and the deciding player are always the same there),
  // but wrong under remote activation, where they can differ. Here,
  // alice remotely activates bob's Army Sniper; the *only* Rebel card at
  // its location is alice's own Rebel Soldier — "opposing to bob" (the
  // old, wrong check) says yes, but "opposing to alice" (who's actually
  // deciding, and who decideEliminateTargetIds correctly filters against
  // once the ability is committed to) says no candidates exist at all. A
  // real bot got stuck exactly this way, remotely activating Army
  // Sniper's ability and then having nothing legal left to submit.
  it("never remotely activates an ability whose only target is the deciding player's own card", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Puppet-Master guaranteed dealt
    const puppetMaster = findByDefRef(state, "Puppet-Master");
    const player = puppetMaster.controller ?? state.turn.currentPlayerId;
    const pmLoc = state.board[0]!.id;
    const armySniper = findByDefRef(state, "Army Sniper");
    const otherPlayer = state.players.find((p) => p.id !== player)!.id;
    const sniperLoc = state.board[1]!.id;
    const rebelSoldier = findByDefRef(state, "Rebel Soldier");
    state = place(state, puppetMaster.id, pmLoc, player);
    state = place(state, armySniper.id, sniperLoc, otherPlayer);
    state = place(state, rebelSoldier.id, sniperLoc, player); // the only Rebel card there, and it's the decider's own
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: puppetMaster.id,
      actingPlayerId: player,
      abilityIndex: 1, // Puppet-Master's second Activate ability: activateRemote, no faction filter
      locationId: pmLoc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toMatchObject({ type: "chooseTargets" });
      const targetIds = (action as { targetIds: readonly string[] }).targetIds;
      expect(targetIds).not.toContain(armySniper.id);
    }
  });

  it("never activates Wife's ability when she isn't at the President's location", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    state = place(state, wife.id, state.board[0]!.id, player);
    state = { ...state, president: { status: "alive", locationId: state.board[2]!.id } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, forceActivateAbility);
    expect(action).toEqual({ type: "endTurn" });
  });
});
