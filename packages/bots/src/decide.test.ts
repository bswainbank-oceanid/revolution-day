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

  // Regression: Puppet-Master's "Play 2 cards" grants restrictedPlayActions
  // (TurnState), spendable only on playCard/playMotorcade — the top-level
  // category selection needs to know actionsRemaining and
  // restrictedPlayActions gate different things, or a bot with 0 normal
  // actions left would either end its turn early (discarding real plays
  // still available) or try to draw/activate/move with a budget that
  // can't pay for any of those.
  it("keeps playing hand cards from restricted actions even with no normal actions left", () => {
    let state = freshGame(["a", "b", "c"]);
    const player = state.turn.currentPlayerId;
    state = {
      ...state,
      turn: {
        ...state.turn,
        phase: "action",
        actionsRemaining: 0,
        restrictedAction: { kind: "play", amount: 2, faction: null, locationId: null, ignoreLocationRestrictions: false },
      },
    };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(["playCard", "playMotorcade", "endTurn"]).toContain(action.type); // depends on what's in hand
      expect(action.type).not.toBe("draw");
      expect(action.type).not.toBe("activateAbility");
      expect(action.type).not.toBe("moveCard");
    }
  });

  // Regression: Commander General's "activate any number of your regime
  // cards at this location" grants a restricted "activate" action
  // narrowed by both faction and location (RestrictedActionGrant) — with
  // the normal budget gone, only a card matching BOTH should ever be
  // picked, never a same-controller card that's the wrong faction or at
  // the wrong location, even when that card also has a legal target.
  it("only activates own cards matching a restricted 'activate' grant's faction and location", () => {
    let state = freshGame(["a", "b", "c"]);
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const otherLoc = state.board[1]!.id;
    const guard = findByDefRef(state, "Republican Guard"); // Regime, at the grant's location
    const soldier = state.cards.find((c) => c.defRef === "Rebel Soldier" && c.id !== guard.id)!; // Rebel, elsewhere
    const guardTarget = state.cards.find((c) => c.defRef === "Prominent Citizen")!;
    const soldierTarget = state.cards.find(
      (c) => c.defRef === "Prominent Citizen" && c.id !== guardTarget.id,
    )!;
    state = place(state, guard.id, loc, player);
    state = place(state, soldier.id, otherLoc, player);
    state = place(state, guardTarget.id, loc, other);
    state = place(state, soldierTarget.id, otherLoc, other); // gives soldier a legal target too
    state = {
      ...state,
      turn: {
        ...state.turn,
        currentPlayerId: player,
        phase: "action",
        actionsRemaining: 0,
        restrictedAction: {
          kind: "activate",
          amount: "unbounded",
          faction: "Regime",
          locationId: loc,
          ignoreLocationRestrictions: false,
        },
      },
    };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(["activateAbility", "endTurn"]).toContain(action.type);
      if (action.type === "activateAbility") {
        expect(action.cardId).toBe(guard.id);
      }
      expect(action.type).not.toBe("draw");
      expect(action.type).not.toBe("moveCard");
      expect(action.type).not.toBe("playCard");
    }
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

  // Regression: eliminateCandidatePool (shared by bots and the client)
  // only applied the selector's own kind/faction/location/etc. filters via
  // candidateInPlayCards, never Protected-immunity — so a genuinely
  // shielded card would still show up as a legal candidate here, and a
  // real submission targeting it would be rejected by the engine's own
  // declareEliminateTargets (which does apply it). Bots silently retried
  // past this (takeBotTurn.ts), masking it — a human client submitting
  // the same choice would get permanently stuck with no legal way to
  // recover. isLegalEliminationTargetFiltered closes this gap.
  it("excludes a Protected card from the eliminate candidate pool while a same-faction protector shields it", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Head of Security guaranteed dealt
    const guard = findByDefRef(state, "Republican Guard");
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const target = state.cards.find((c) => c.kind === "leader" && c.defRef === "Head of Security")!;
    const protector = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== guard.id,
    )!;
    state = place(state, guard.id, loc, player);
    state = place(state, target.id, loc, other);
    state = place(state, protector.id, loc, other); // Regime, non-Protected — shields target
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };

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
      expect(targetIds).not.toContain(target.id);
    }
  });

  // Regression: reducer.ts's declareEliminateTargets bypasses
  // Protected-immunity entirely for a re-choice after a Protected-
  // targeting reveal window (bypassProtectionOverride, driven by
  // AbilityResolutionFrame.reselectingAfterReveal — "that re-choice is
  // final by design, not a fresh declaration"), but eliminateCandidatePool
  // had no idea that field existed and kept filtering by protection
  // anyway. With a real protector still present, the previously-protected
  // target stayed wrongly excluded from the pool even though the engine
  // would accept it unconditionally — a real user hit this using
  // Insurgent Sniper on the President after an unrelated reveal put the
  // ability into reselectingAfterReveal.
  it("bypasses Protected-immunity entirely when reselecting after a reveal window", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Head of Security guaranteed dealt
    const guard = findByDefRef(state, "Republican Guard");
    const player = state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const target = state.cards.find((c) => c.kind === "leader" && c.defRef === "Head of Security")!;
    const protector = state.cards.find(
      (c) => c.kind === "nonLeader" && c.defRef === "Prominent Citizen" && c.id !== guard.id,
    )!;
    state = place(state, guard.id, loc, player);
    state = place(state, target.id, loc, other);
    state = place(state, protector.id, loc, other); // would normally shield target
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: guard.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
      reselectingAfterReveal: true,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const seenTargetIds = new Set<string>();
    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toMatchObject({ type: "chooseTargets" });
      for (const id of (action as { targetIds: readonly string[] }).targetIds) seenTargetIds.add(id);
    }
    // Without the fix, `target` stays wrongly excluded no matter the
    // roll — every pick lands on `protector` instead, and target is
    // never reachable at all.
    expect(seenTargetIds.has(target.id)).toBe(true);
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

    // Guard's ability has no legal target here, so it's excluded from the
    // usable-ability pool entirely — decideTurnAction never even offers
    // "activateAbility" as a category, regardless of the random roll.
    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "activateAbility", cardId: guard.id });
    }
  });

  it("Wife always targets the President (the only candidate her ability offers)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Wife guaranteed dealt
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    state = place(state, wife.id, loc, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    // Wife's ability requires co-location (location: {mode: "self"} in
    // abilityEffects.ts) — must match her location, not an arbitrary one.
    state = { ...state, president: { status: "alive", locationId: loc } };

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
    // An eliminate-capable target must actually be present, or ability
    // index 1 (eliminate+blend) is correctly excluded as unusable and
    // index 0 (returnToHand+play) becomes the only real option — this
    // needs a genuine choice between the two to test the preference.
    const target = state.cards.filter((c) => c.defRef === "Prominent Citizen")[0]!;
    const other = state.players.find((p) => p.id !== player)!.id;
    state = place(state, assassin.id, loc, player);
    state = place(state, target.id, loc, other);
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
  // decideTurnAction only ever offers "activateAbility" as a category when
  // some own in-play card actually has a usable ability (see
  // usableActivateAbilities) — with only one card in play and its sole
  // ability excluded, "activateAbility" is never offered at all, so
  // rng()=0.8 reliably lands on whichever categories remain (draw, etc.),
  // never on the excluded ability. When it IS legally usable, all four
  // categories are back to the original 40/30/20/10 split (playCard 0-40,
  // draw 40-70, activateAbility 70-90, moveCard 90-100), so 0.8 still
  // deterministically lands on "activateAbility" for the "does activate"
  // tests below.
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

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "activateAbility", cardId: trafficCop.id });
    }
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

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "activateAbility", cardId: wife.id });
    }
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

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "activateAbility", cardId: wife.id });
    }
  });
});
