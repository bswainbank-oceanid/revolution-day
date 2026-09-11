import { cardData, filterForPlayer, setupGame } from "@rev-day/engine";
import type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  CardInstance,
  GameState,
  MotorcadeInterceptionWindowFrame,
  PlayerId,
} from "@rev-day/engine";
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

  // Co-location alone isn't enough to make this a good move any more: Wife's
  // win condition ("President eliminated at the Palace") means activating
  // her elsewhere gains her nothing and forecloses it for good, so
  // effectivePresidentObjective now suppresses this off-Palace — this test
  // moved to the Palace so it still exercises "does activate when the
  // legitimate case is met." The off-Palace case is covered by the
  // "Wife's location-gated objective" describe block below.
  it("does activate Wife's ability while she's at the President's location, at the Palace", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    state = place(state, wife.id, palace, player);
    state = { ...state, president: { status: "alive", locationId: palace } };
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

  // Regression: activating any card unconditionally reveals it first (see
  // reducer.ts's applyActivateAbility) — abilityHasAvailableFirstTarget's
  // activateRemote pre-check evaluated candidates against the card's
  // *current* (still-blended) state, not the post-reveal state activation
  // would actually produce. Here, Guerrilla Commander is the only card
  // Journalist could ever reveal at this location (Journalist's own
  // Activate ability needs a blended target here) — but activating
  // Guerrilla Commander's remote-activate reveals Guerrilla Commander
  // itself first, so by the time Journalist would actually be chosen and
  // resolved, its own ability has nothing left to reveal. A real bot got
  // stuck exactly this way: the pre-check said Journalist was usable, the
  // ability committed, and the follow-up chooseTargets had nothing legal
  // to submit.
  it("never remotely activates a candidate whose own usability depended on the activating card's blend it's about to lose", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]); // 8 players — Guerrilla Commander guaranteed dealt
    const guerrilla = findByDefRef(state, "Guerrilla Commander");
    const player = guerrilla.controller ?? state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const journalist = findByDefRef(state, "Journalist");
    state = place(state, guerrilla.id, loc, player, false); // blended — the only thing Journalist could reveal here
    state = place(state, journalist.id, loc, player); // face-up Rebel nonLeader — a legal remote-activation candidate
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "activateAbility", cardId: guerrilla.id });
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

describe("decideBotAction: Wife's location-gated objective", () => {
  it("activates Wife's ability the instant the President is at the Palace, bypassing the normal play/activate coinflip", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    state = place(state, wife.id, palace, player);
    state = { ...state, president: { status: "alive", locationId: palace } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toEqual({ type: "activateAbility", cardId: wife.id, abilityIndex: 0 });
    }
  });

  it("does not activate Wife's ability when co-located with the President away from the Palace", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    const notPalace = state.board[0]!.id;
    state = place(state, wife.id, notPalace, player);
    state = { ...state, president: { status: "alive", locationId: notPalace } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5, (): number => 0.8]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "activateAbility", cardId: wife.id });
    }
  });

  it("does not force Wife's activation when she's elsewhere, even with the President at the Palace", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = state.turn.currentPlayerId;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const elsewhere = state.board[0]!.id;
    state = place(state, wife.id, elsewhere, player);
    state = { ...state, president: { status: "alive", locationId: palace } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "activateAbility", cardId: wife.id });
  });

  it("deploys Wife from hand to the Palace once the President is within the deploy-distance threshold", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const nearPalace = state.board[state.board.length - 3]!.id; // 2 steps away
    state = { ...state, president: { status: "alive", locationId: nearPalace } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero); // zero -> coinFlip picks the "play" branch
    expect(action).toEqual({ type: "playCard", cardId: wife.id, locationId: palace });
  });

  it("does not prematurely deploy Wife while the President is still far from the Palace and the deck isn't low", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const farFromPalace = state.board[0]!.id;
    state = { ...state, president: { status: "alive", locationId: farFromPalace } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: wife.id, locationId: state.board.find((l) => l.name === "Palace")!.id });
  });

  it("routes an in-play Regime card toward the President's current location for protection, instead of a random adjacent step", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const presidentLoc = state.board[1]!.id;
    const guardStart = state.board[0]!.id; // adjacent to presidentLoc, and strictly closer to it than the Palace
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!; // Regime, eliminate-capable
    state = place(state, guard.id, guardStart, player);
    state = { ...state, president: { status: "alive", locationId: presidentLoc } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    // Force the move branch specifically: no playable hand card and no
    // drawable deck, so play/activate/draw are all unavailable and only
    // moveCard is left — isolates decideMoveCard's own routing logic.
    state = {
      ...state,
      cards: state.cards.map((c) =>
        (c.zone === "hand" || c.zone === "deck") && (c.zone !== "hand" || c.controller === player)
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "moveCard", cardId: guard.id, toLocationId: presidentLoc });
  });

  // Regression: a genuine self-sabotage bug the live simulation caught —
  // presidentObjectiveFor collapses Wife's presidentEliminatedAt predicate
  // to a location-blind "eliminate", so without effectivePresidentObjective
  // overriding it, a Republican Guard controlled by Wife's own player would
  // happily snipe the President wherever he happened to be, permanently
  // foreclosing her actual win condition. A legal, non-President target is
  // available here, so the Guard should prefer it.
  it("prefers a non-President target over sniping the President away from the Palace, for Wife's own player", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id; // not the Palace
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const opposingTarget = state.cards.find((c) => c.defRef === "Prominent Citizen")!;
    state = place(state, guard.id, loc, player);
    state = place(state, opposingTarget.id, loc, other);
    state = { ...state, president: { status: "alive", locationId: loc } };
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

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [opposingTarget.id] });
  });
});

describe("decideBotAction: routing Motorcade interceptors ('mobs') for Wife's controller", () => {
  it("deploys a mob to the staging location before the Palace, not the Palace itself, from hand", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const mob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    state = {
      ...state,
      cards: state.cards.map((c) => (c.id === mob.id ? { ...c, zone: "hand" as const, controller: player } : c)),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: mob.id, locationId: staging });
  });

  it("routes an already-staged mob toward the Palace via movement, not a random adjacent step", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const mob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    const palace = state.board[palaceIndex]!.id;
    state = place(state, mob.id, staging, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    // Force the move branch: no playable hand card and no drawable deck.
    state = {
      ...state,
      cards: state.cards.map((c) =>
        (c.zone === "hand" || c.zone === "deck") && (c.zone !== "hand" || c.controller === player)
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "moveCard", cardId: mob.id, toLocationId: palace });
  });

  it("always intercepts to prevent the President leaving the Palace, regardless of whose turn it nominally is", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const mob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    state = place(state, mob.id, palace, player);
    state = { ...state, president: { status: "alive", locationId: palace } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: other, phase: "action" } };

    const frame: MotorcadeInterceptionWindowFrame = {
      kind: "motorcadeInterceptionWindow",
      actingPlayerId: other,
      presidentLocationId: palace,
      order: [player],
      nextIndex: 0,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toEqual({ type: "interceptMotorcade", cardId: mob.id });
    }
  });

  it("intercepts by default at the staging location when it isn't this player's own turn", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    const mob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    state = place(state, mob.id, staging, player);
    state = { ...state, president: { status: "alive", locationId: staging } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: other, phase: "action" } };

    const frame: MotorcadeInterceptionWindowFrame = {
      kind: "motorcadeInterceptionWindow",
      actingPlayerId: other,
      presidentLocationId: staging,
      order: [player],
      nextIndex: 0,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toEqual({ type: "interceptMotorcade", cardId: mob.id });
    }
  });

  it("lets the motorcade through at the staging location once it's already this player's own turn", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    const mob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    state = place(state, mob.id, staging, player);
    state = { ...state, president: { status: "alive", locationId: staging } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };

    const frame: MotorcadeInterceptionWindowFrame = {
      kind: "motorcadeInterceptionWindow",
      actingPlayerId: other,
      presidentLocationId: staging,
      order: [player],
      nextIndex: 0,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toEqual({ type: "passIntercept" });
    }
  });
});

describe("decideBotAction: general escort rule (Protected + survives leaders)", () => {
  it("only plays a needs-escort leader (Commander General) at a location it already has an escort", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const escortLoc = state.board.find((l) => l.type === "Secure")!.id; // his own allowed type
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, guard.id, escortLoc, player);
    // Force him to be the only playable hand card.
    state = {
      ...state,
      cards: state.cards.map((c) =>
        c.zone === "hand" && c.controller === player && c.id !== commanderGeneral.id
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: commanderGeneral.id, locationId: escortLoc });
  });

  it("doesn't play a needs-escort leader anywhere when no escort exists at all", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    state = {
      ...state,
      cards: state.cards.map((c) =>
        c.zone === "hand" && c.controller === player && c.id !== commanderGeneral.id
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).not.toMatchObject({ type: "playCard", cardId: commanderGeneral.id });
    }
  });

  it("stays put rather than moving a needs-escort leader into an unescorted adjacent location", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const loc = state.board[2]!.id; // interior — both neighbors exist, neither escorted
    state = place(state, commanderGeneral.id, loc, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    // No playable hand card, no drawable deck — isolates decideMoveCard.
    state = {
      ...state,
      cards: state.cards.map((c) =>
        (c.zone === "hand" || c.zone === "deck") && (c.zone !== "hand" || c.controller === player)
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "endTurn" });
  });

  it("prefers drawing over the normal chain when it needs an escort but has no same-faction card in hand", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    // Empty this player's hand entirely — no same-faction card to play.
    state = {
      ...state,
      cards: state.cards.map((c) => (c.zone === "hand" && c.controller === player ? { ...c, zone: "discard" as const } : c)),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    for (const rng of [zero, near1, (): number => 0.5]) {
      const action = decideBotAction(filtered, player, cardData, rng);
      expect(action).toEqual({ type: "draw" });
    }
  });
});

describe("decideBotAction: Head of Security's strategy", () => {
  it("deploys once the President reaches position 3 (1-indexed), preferring an escorted location", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    const triggerLoc = state.board[2]!.id; // 0-indexed 2 == "position 3"
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, guard.id, triggerLoc, player);
    state = { ...state, president: { status: "alive", locationId: triggerLoc } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: hos.id, locationId: triggerLoc });
  });

  it("deploys once the deck is running low, regardless of the President's position", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    const loc = state.board[0]!.id;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, guard.id, loc, player);
    state = { ...state, president: { status: "notEntered", locationId: null } };
    let deckSeen = 0;
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.zone !== "deck") return c;
        deckSeen += 1;
        return deckSeen <= 8 ? c : { ...c, zone: "discard" as const };
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: hos.id, locationId: loc });
  });

  it("does not prematurely deploy while the President is far off and the deck isn't low", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    state = { ...state, president: { status: "alive", locationId: state.board[0]!.id } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: hos.id });
  });

  it("prefers playing a Motorcade card once deployed and rushing", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    const loc = state.board[0]!.id; // "Street" — not legal for Republican Guard ("Secure" only), so its
    // own escort routing below can't accidentally produce a competing purposeful play here.
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!; // a Regime card in hand, so
    // the unrelated "draw when no same-faction card in hand" preference doesn't fire first.
    state = place(state, hos.id, loc, player);
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === motorcade.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.id === guard.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player) return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, president: { status: "notEntered", locationId: null } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playMotorcade", cardId: motorcade.id });
  });

  it("biases Traffic Cop's move toward the President's forward direction", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const loc = state.board[2]!.id; // interior — both neighbors exist
    state = place(state, trafficCop.id, loc, player);
    state = { ...state, president: { status: "alive", locationId: loc } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: trafficCop.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [], locationIds: [state.board[3]!.id] });
  });

  it("prefers remotely activating an eliminate-capable Regime card over a merely-usable one", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const thirdParty = state.players.find((p) => p.id !== player && p.id !== other)!.id;
    const loc = state.board[2]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const guardTarget = state.cards.find((c) => c.defRef === "Prominent Citizen")!;
    state = place(state, trafficCop.id, loc, other);
    state = place(state, guard.id, loc, other);
    state = place(state, guardTarget.id, loc, thirdParty);
    state = { ...state, president: { status: "alive", locationId: loc } }; // makes Traffic Cop's move usable too

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: hos.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toMatchObject({ type: "chooseTargets", targetIds: [guard.id] });
  });

  it("prefers remotely activating a reveal-blended-capable Regime card when nothing eliminate-capable is available", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hos = findByDefRef(state, "Head of Security");
    const player = hos.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[2]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const secretPolice = state.cards.find((c) => c.defRef === "Secret Police")!;
    const hiddenTarget = state.cards.find((c) => c.defRef === "Martyr")!; // Rebel, Blend
    state = place(state, trafficCop.id, loc, other);
    state = place(state, secretPolice.id, loc, other);
    state = place(state, hiddenTarget.id, loc, other, false);
    state = { ...state, president: { status: "alive", locationId: loc } }; // makes Traffic Cop's move usable

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: hos.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toMatchObject({ type: "chooseTargets", targetIds: [secretPolice.id] });
  });
});

describe("decideBotAction: generic 'eliminate the President' Motorcade/Traffic Cop discipline", () => {
  it("does not play a Motorcade card when the next location isn't a trap", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = { ...state, president: { status: "alive", locationId: state.board[0]!.id } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === motorcade.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player) return { ...c, zone: "discard" as const };
        if (c.zone === "deck") return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playMotorcade" });
  });

  it("plays a Motorcade card once the next location already has a trap set", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const trapLoc = state.board[1]!.id;
    state = place(state, guard.id, trapLoc, player);
    state = { ...state, president: { status: "alive", locationId: state.board[0]!.id } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === motorcade.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player) return { ...c, zone: "discard" as const };
        if (c.zone === "deck") return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playMotorcade", cardId: motorcade.id });
  });

  it("pushes the President backward via Traffic Cop when the next location isn't a trap", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const loc = state.board[2]!.id; // interior — both neighbors exist, neither is a trap
    state = place(state, trafficCop.id, loc, player);
    state = { ...state, president: { status: "alive", locationId: loc } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: trafficCop.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [], locationIds: [state.board[1]!.id] });
  });

  it("pushes the President forward via Traffic Cop when the next location already has a trap", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard" && c.id !== trafficCop.id)!;
    const loc = state.board[2]!.id;
    const trapLoc = state.board[3]!.id;
    state = place(state, trafficCop.id, loc, player);
    state = place(state, guard.id, trapLoc, player);
    state = { ...state, president: { status: "alive", locationId: loc } };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: trafficCop.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [], locationIds: [trapLoc] });
  });
});

describe("decideBotAction: Commander General's strategy", () => {
  it("routes an eliminate-capable Regime card to the President's location when playing from hand", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const presidentLoc = state.board[1]!.id; // "HQ" — a legal ("Secure") location for the Guard too
    state = { ...state, president: { status: "alive", locationId: presidentLoc } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === guard.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player && c.id !== commanderGeneral.id) return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: guard.id, locationId: presidentLoc });
  });

  it("routes an already in-play eliminate-capable Regime card toward the President via movement", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const presidentLoc = state.board[1]!.id;
    const guardStart = state.board[0]!.id;
    state = place(state, guard.id, guardStart, player);
    state = { ...state, president: { status: "alive", locationId: presidentLoc } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    state = {
      ...state,
      cards: state.cards.map((c) =>
        (c.zone === "hand" || c.zone === "deck") && (c.zone !== "hand" || c.controller === player)
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "moveCard", cardId: guard.id, toLocationId: presidentLoc });
  });

  it("deploys at HQ once the President is eliminated, preferring an escorted spot", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const hq = state.board.find((l) => l.name === "HQ")!.id;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    state = place(state, guard.id, hq, player);
    state = { ...state, president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: commanderGeneral.id, locationId: hq });
  });

  it("prefers eliminating a Rebel-faction target over an equally-opposing Regime one", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const eliminator = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const rebelTarget = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    const regimeTarget = state.cards.find((c) => c.defRef === "Republican Guard" && c.id !== eliminator.id)!;
    state = place(state, eliminator.id, loc, player);
    state = place(state, rebelTarget.id, loc, other);
    state = place(state, regimeTarget.id, loc, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: eliminator.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [rebelTarget.id] });
  });

  it("prefers using his own abilities once at HQ, over an unrelated usable ability elsewhere", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const commanderGeneral = findByDefRef(state, "Commander General");
    const player = commanderGeneral.controller!;
    const hq = state.board.find((l) => l.name === "HQ")!.id;
    const elsewhere = state.board[3]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    state = place(state, commanderGeneral.id, hq, player);
    state = place(state, trafficCop.id, elsewhere, player);
    state = { ...state, president: { status: "alive", locationId: elsewhere } };
    // Empty the deck so the "draw when no same-faction card in hand"
    // preference (which doesn't know or care about HQ) can't fire first
    // regardless of what this game's random deal happened to put in hand.
    state = { ...state, cards: state.cards.map((c) => (c.zone === "deck" ? { ...c, zone: "discard" as const } : c)) };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, near1);
    expect(action).toMatchObject({ type: "activateAbility", cardId: commanderGeneral.id });
  });
});

describe("decideBotAction: Master Assassin's strategy", () => {
  it("protects the President by routing a Regime card to his location when not ready to strike himself", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const guard = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const presidentLoc = state.board[1]!.id; // "HQ" — legal ("Secure") for the Guard too
    state = { ...state, president: { status: "alive", locationId: presidentLoc } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === guard.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player && c.id !== masterAssassin.id) return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: guard.id, locationId: presidentLoc });
  });

  it("routes an eliminate-capable card of any faction toward the President, not restricted to Regime", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const assassinCard = state.cards.find((c) => c.defRef === "Assassin")!; // Rebel, eliminate-capable
    const presidentLoc = state.board[0]!.id; // "Street" — legal for the Assassin too
    state = { ...state, president: { status: "alive", locationId: presidentLoc } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === assassinCard.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player && c.id !== masterAssassin.id) return { ...c, zone: "discard" as const };
        // Neither Master Assassin nor the Assassin card is Regime, so with
        // nothing Regime in hand the "draw to look for a protector"
        // preference would otherwise fire first — empty the deck so it
        // can't, regardless of what this game's random deal put in hand.
        if (c.zone === "deck") return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: assassinCard.id, locationId: presidentLoc });
  });

  it("does not deploy to pounce on the President before he reaches board position 4", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    state = { ...state, president: { status: "alive", locationId: state.board[2]!.id } }; // position 3
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: masterAssassin.id });
  });

  it("deploys directly onto the President once he's unprotected at board position 4", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const pounceLoc = state.board[3]!.id; // position 4
    state = { ...state, president: { status: "alive", locationId: pounceLoc } };
    // No Regime card in hand for a Rebel leader — see the previous test's
    // own comment on why the deck needs to be empty here too.
    state = { ...state, cards: state.cards.map((c) => (c.zone === "deck" ? { ...c, zone: "discard" as const } : c)) };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: masterAssassin.id, locationId: pounceLoc });
  });

  it("does not pounce on the President at position 4 when he's protected", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const pounceLoc = state.board[3]!.id;
    const protector = state.cards.find((c) => c.defRef === "Republican Guard")!; // Regime, non-Protected
    state = place(state, protector.id, pounceLoc, other);
    state = { ...state, president: { status: "alive", locationId: pounceLoc } };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: masterAssassin.id, locationId: pounceLoc });
  });

  it("deploys to a blend-rich location once the President is eliminated", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const hiddenLoc = state.board[2]!.id;
    const hiddenCard = state.cards.find((c) => c.defRef === "Secret Police")!; // Regime, Blend
    state = place(state, hiddenCard.id, hiddenLoc, other, false);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[0]!.id, eliminatedByPlayerId: other },
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: masterAssassin.id, locationId: hiddenLoc });
  });

  it("moves toward a blend-rich location once the President is eliminated", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const startLoc = state.board[0]!.id;
    const hiddenLoc = state.board[1]!.id;
    const hiddenCard = state.cards.find((c) => c.defRef === "Secret Police")!;
    state = place(state, masterAssassin.id, startLoc, player);
    state = place(state, hiddenCard.id, hiddenLoc, other, false);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id, eliminatedByPlayerId: other },
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    state = {
      ...state,
      cards: state.cards.map((c) =>
        (c.zone === "hand" || c.zone === "deck") && (c.zone !== "hand" || c.controller === player)
          ? { ...c, zone: "discard" as const }
          : c,
      ),
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "moveCard", cardId: masterAssassin.id, toLocationId: hiddenLoc });
  });

  it("prefers returning to hand once hunting other leaders, when it isn't his final turn", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    state = place(state, masterAssassin.id, loc, player);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id, eliminatedByPlayerId: other },
    };
    state = {
      ...state,
      turn: { ...state.turn, currentPlayerId: player, phase: "action", endgameTurnsRemaining: 20 }, // well above players.length (8) — not his final turn
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, near1);
    expect(action).toEqual({ type: "activateAbility", cardId: masterAssassin.id, abilityIndex: 0 });
  });

  it("does not force returning to hand on his own final turn, when something else is usable", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const angryMob = state.cards.find((c) => c.defRef === "Angry Mob")!; // unrelated but always-usable Activate ability
    state = place(state, masterAssassin.id, loc, player);
    state = place(state, angryMob.id, loc, player);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id, eliminatedByPlayerId: other },
    };
    state = {
      ...state,
      turn: { ...state.turn, currentPlayerId: player, phase: "action", endgameTurnsRemaining: 8 }, // === players.length (8) — his final turn
    };
    const filtered = filterForPlayer(state, player);

    // rng chosen to land on the *second* of the two usable (own leader,
    // Angry Mob) options if the final-turn suppression is actually
    // working — if it weren't, this would always come back as Master
    // Assassin's own return-to-hand ability regardless.
    const pickSecond: Rng = () => 0.9;
    const action = decideBotAction(filtered, player, cardData, pickSecond);
    expect(action).toEqual({ type: "activateAbility", cardId: angryMob.id, abilityIndex: 0 });
  });

  it("prefers eliminating another leader over a non-leader card once the President is eliminated", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const otherLeader = state.cards.find((c) => c.kind === "leader" && c.controller === other)!;
    // Whichever faction otherLeader *isn't* — some leaders are Protected,
    // and a same-faction non-Protected card at the same location would
    // shield them, silently removing them from the candidate pool. Using
    // the opposite faction for the non-leader decoy guarantees that can
    // never happen, regardless of which leader "other" was actually dealt.
    const otherLeaderFaction = cardData.leaders.find((l) => l.name === otherLeader.defRef)!.faction;
    const decoyFaction = otherLeaderFaction === "Regime" ? "Rebel Soldier" : "Prominent Citizen";
    const nonLeaderTarget = state.cards.find((c) => c.defRef === decoyFaction)!;
    state = place(state, masterAssassin.id, loc, player);
    state = place(state, otherLeader.id, loc, other);
    state = place(state, nonLeaderTarget.id, loc, other);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id, eliminatedByPlayerId: other },
    };

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: masterAssassin.id,
      actingPlayerId: player,
      abilityIndex: 1, // "Eliminate a target and blend"
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [otherLeader.id] });
  });

  it("stops preferring the return-to-hand ability once he's already secured his backup win (2 leaders)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const angryMob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    const otherLeaders = state.cards.filter((c) => c.kind === "leader" && c.controller !== player).slice(0, 2);
    state = {
      ...state,
      cards: state.cards.map((c) =>
        otherLeaders.some((l) => l.id === c.id) ? { ...c, zone: "eliminated" as const, eliminatedByPlayerId: player } : c,
      ),
    };
    state = place(state, masterAssassin.id, loc, player);
    state = place(state, angryMob.id, loc, player);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id, eliminatedByPlayerId: other },
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", endgameTurnsRemaining: 20 } }; // not his final turn
    const filtered = filterForPlayer(state, player);

    // rng chosen to land on the *second* of the two usable options — if
    // the backup-win-secured gate weren't working, this would still come
    // back as Master Assassin's own return-to-hand ability regardless.
    const pickSecond: Rng = () => 0.9;
    const action = decideBotAction(filtered, player, cardData, pickSecond);
    expect(action).toEqual({ type: "activateAbility", cardId: angryMob.id, abilityIndex: 0 });
  });

  it("does not deploy toward blend-rich areas once he's already secured his backup win", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const hiddenLoc = state.board[2]!.id;
    const hiddenCard = state.cards.find((c) => c.defRef === "Secret Police")!;
    const otherLeaders = state.cards.filter((c) => c.kind === "leader" && c.controller !== player).slice(0, 2);
    state = {
      ...state,
      cards: state.cards.map((c) =>
        otherLeaders.some((l) => l.id === c.id) ? { ...c, zone: "eliminated" as const, eliminatedByPlayerId: player } : c,
      ),
    };
    state = place(state, hiddenCard.id, hiddenLoc, other, false);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[0]!.id, eliminatedByPlayerId: other },
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: masterAssassin.id, locationId: hiddenLoc });
  });

  it("does not hunt other leaders once he eliminated the President himself (first branch already satisfied)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const masterAssassin = findByDefRef(state, "Master Assassin");
    const player = masterAssassin.controller!;
    const loc = state.board[0]!.id;
    const angryMob = state.cards.find((c) => c.defRef === "Angry Mob")!;
    state = place(state, masterAssassin.id, loc, player);
    state = place(state, angryMob.id, loc, player);
    state = {
      ...state,
      president: { status: "eliminated", locationId: null, eliminatedAtLocationId: state.board[3]!.id, eliminatedByPlayerId: player },
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", endgameTurnsRemaining: 20 } };
    const filtered = filterForPlayer(state, player);

    const pickSecond: Rng = () => 0.9;
    const action = decideBotAction(filtered, player, cardData, pickSecond);
    expect(action).toEqual({ type: "activateAbility", cardId: angryMob.id, abilityIndex: 0 });
  });
});

describe("decideBotAction: Wife's Motorcade discipline", () => {
  it("plays a Motorcade card while the President is currently protected", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    const protector = state.cards.find((c) => c.defRef === "Republican Guard")!; // Regime, non-Protected — shields him
    state = place(state, protector.id, loc, other);
    state = { ...state, president: { status: "alive", locationId: loc } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === motorcade.id) return { ...c, zone: "hand" as const, controller: player };
        // Wife's own card, still in hand, would otherwise pick up its own
        // purposeful "protect the President" routing here (she's Regime
        // herself) and get played instead — discard it along with
        // everything else, and empty the deck too so the resulting
        // Regime-less hand doesn't trigger the unrelated draw preference.
        if (c.zone === "hand" && c.controller === player) return { ...c, zone: "discard" as const };
        if (c.zone === "deck") return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playMotorcade", cardId: motorcade.id });
  });

  it("does not play a Motorcade card while the President is currently unprotected", () => {
    let state = freshGame(["a", "b", "c"]);
    const wife = findByDefRef(state, "Wife");
    const player = wife.controller ?? state.turn.currentPlayerId;
    const loc = state.board[0]!.id;
    const motorcade = state.cards.find((c) => c.kind === "motorcade")!;
    state = { ...state, president: { status: "alive", locationId: loc } };
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === motorcade.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player) return { ...c, zone: "discard" as const };
        if (c.zone === "deck") return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playMotorcade" });
  });
});

describe("decideBotAction: Guerrilla Commander's strategy", () => {
  it("deploys at the staging spot before the Palace once the mid-game trigger fires (deck low)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    let deckSeen = 0;
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.zone !== "deck") return c;
        deckSeen += 1;
        return deckSeen <= 14 ? c : { ...c, zone: "discard" as const };
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: guerrillaCommander.id, locationId: staging });
  });

  it("does not prioritize deploying before her mid-game trigger fires", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    state = { ...state, president: { status: "alive", locationId: state.board[0]!.id } }; // position 1, deck full
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: guerrillaCommander.id, locationId: staging });
  });

  it("routes a Rebel card to the staging spot once the mid-game trigger fires", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const rebelSoldier = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    let deckSeen = 0;
    // Already in play, not in hand, so she's out of the hand-play
    // competition — isolates the "any Rebel card" routing from her own
    // dedicated deploy priority above.
    state = place(state, guerrillaCommander.id, state.board[0]!.id, player);
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.id === rebelSoldier.id) return { ...c, zone: "hand" as const, controller: player };
        if (c.zone === "hand" && c.controller === player && c.id !== rebelSoldier.id) return { ...c, zone: "discard" as const };
        if (c.zone === "deck") {
          deckSeen += 1;
          return deckSeen <= 14 ? c : { ...c, zone: "discard" as const };
        }
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: rebelSoldier.id, locationId: staging });
  });

  it("moves an already in-play Rebel card toward the Palace via the staging spot", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const rebelSoldier = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const palaceIndex = state.board.findIndex((l) => l.name === "Palace");
    const staging = state.board[palaceIndex - 1]!.id;
    const startLoc = state.board[palaceIndex - 2]!.id; // two steps before the Palace
    state = place(state, rebelSoldier.id, startLoc, player);
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.zone === "hand" && c.controller === player) return { ...c, zone: "discard" as const };
        if (c.zone === "deck") return { ...c, zone: "discard" as const };
        return c;
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action", actionsRemaining: 2 } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "moveCard", cardId: rebelSoldier.id, toLocationId: staging });
  });

  it("prefers using her own ability over an unrelated usable one, unconditionally", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    const hiddenCard = state.cards.find((c) => c.defRef === "Secret Police")!;
    state = place(state, guerrillaCommander.id, loc, player);
    state = place(state, trafficCop.id, loc, player);
    state = place(state, hiddenCard.id, loc, other, false); // makes her own reveal ability usable
    state = { ...state, president: { status: "alive", locationId: loc } }; // makes Traffic Cop's move usable too
    state = { ...state, cards: state.cards.map((c) => (c.zone === "deck" ? { ...c, zone: "discard" as const } : c)) };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, near1);
    expect(action).toMatchObject({ type: "activateAbility", cardId: guerrillaCommander.id });
  });

  it("prefers eliminating Heir Apparent over a non-priority opposing card", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const eliminator = state.cards.find((c) => c.defRef === "Assassin")!; // Rebel, unfiltered eliminate
    const heirApparent = findByDefRef(state, "Heir Apparent");
    // Rebel decoy — can't shield a Regime target (Heir Apparent), unlike
    // a Regime decoy would, so there's no ambiguity about which one wins.
    const decoyTarget = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, eliminator.id, loc, player);
    state = place(state, heirApparent.id, loc, other);
    state = place(state, decoyTarget.id, loc, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: eliminator.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [heirApparent.id] });
  });

  it("prefers eliminating Wife over a non-priority opposing card", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const eliminator = state.cards.find((c) => c.defRef === "Assassin")!;
    const wife = findByDefRef(state, "Wife");
    const decoyTarget = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, eliminator.id, loc, player);
    state = place(state, wife.id, loc, other); // revealed (place defaults faceUp: true)
    state = place(state, decoyTarget.id, loc, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: eliminator.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [wife.id] });
  });

  it("prefers eliminating a still-hidden card at the Palace over a visible non-priority one", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const eliminator = state.cards.find((c) => c.defRef === "Assassin")!;
    const hiddenCard = state.cards.find((c) => c.defRef === "Secret Police")!; // Regime, Blend
    const decoyTarget = state.cards.find((c) => c.defRef === "Republican Guard")!; // visible, no priority
    state = place(state, eliminator.id, palace, player);
    state = place(state, hiddenCard.id, palace, other, false); // still blended
    state = place(state, decoyTarget.id, palace, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: eliminator.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: palace,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [hiddenCard.id] });
  });

  it("prefers a Regime-faction target when striking from the Palace itself", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const guerrillaCommander = findByDefRef(state, "Guerrilla Commander");
    const player = guerrillaCommander.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const palace = state.board.find((l) => l.name === "Palace")!.id;
    const eliminator = state.cards.find((c) => c.defRef === "Assassin")!;
    const regimeTarget = state.cards.find((c) => c.defRef === "Republican Guard")!;
    const rebelDecoy = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, eliminator.id, palace, player);
    state = place(state, regimeTarget.id, palace, other);
    state = place(state, rebelDecoy.id, palace, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: eliminator.id,
      actingPlayerId: player,
      abilityIndex: 0,
      locationId: palace,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [regimeTarget.id] });
  });
});

describe("decideBotAction: Opposition Leader's strategy", () => {
  it("deploys to Arena once the hand-rebel trigger fires (3+ rebels in hand)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppositionLeader = findByDefRef(state, "Opposition Leader");
    const player = oppositionLeader.controller!;
    const arena = state.board.find((l) => l.name === "Arena")!.id;
    const rebels = state.cards
      .filter((c) => c.zone === "deck" && ["Mr. Lucky", "Gunman", "Assassin"].includes(c.defRef!))
      .slice(0, 3);
    expect(rebels).toHaveLength(3);
    state = {
      ...state,
      cards: state.cards.map((c) =>
        rebels.some((r) => r.id === c.id) ? { ...c, zone: "hand" as const, controller: player } : c,
      ),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: oppositionLeader.id, locationId: arena });
  });

  it("deploys to Arena once the round-estimate trigger fires (deck shrunk enough)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppositionLeader = findByDefRef(state, "Opposition Leader");
    const player = oppositionLeader.controller!;
    const arena = state.board.find((l) => l.name === "Arena")!.id;
    let deckSeen = 0;
    state = {
      ...state,
      cards: state.cards.map((c) => {
        if (c.zone !== "deck") return c;
        deckSeen += 1;
        return deckSeen <= 19 ? c : { ...c, zone: "discard" as const };
      }),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: oppositionLeader.id, locationId: arena });
  });

  it("does not prioritize deploying before either trigger fires", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppositionLeader = findByDefRef(state, "Opposition Leader");
    const player = oppositionLeader.controller!;
    const arena = state.board.find((l) => l.name === "Arena")!.id;
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: oppositionLeader.id, locationId: arena });
  });

  it("prefers using her own ability over an unrelated usable one, unconditionally", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppositionLeader = findByDefRef(state, "Opposition Leader");
    const player = oppositionLeader.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const trafficCop = state.cards.find((c) => c.defRef === "Traffic Cop")!;
    state = place(state, oppositionLeader.id, loc, player);
    state = place(state, trafficCop.id, loc, other);
    state = { ...state, president: { status: "alive", locationId: loc } }; // makes Traffic Cop's move usable too
    state = { ...state, cards: state.cards.map((c) => (c.zone === "deck" ? { ...c, zone: "discard" as const } : c)) };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, near1);
    expect(action).toMatchObject({ type: "activateAbility", cardId: oppositionLeader.id });
  });

  it("caps her own location's escort at 2 rebels, then routes further ones toward a location without Rebel presence", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppositionLeader = findByDefRef(state, "Opposition Leader");
    const player = oppositionLeader.controller!;
    const home = state.board[0]!.id; // Street
    const nextStreet = state.board[2]!.id; // Street — first non-Secure location lacking Rebel presence
    const escort1 = state.cards.find((c) => c.defRef === "Mr. Lucky")!;
    const escort2 = state.cards.find((c) => c.defRef === "Gunman")!;
    const newcomer = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, oppositionLeader.id, home, player);
    state = place(state, escort1.id, home, player);
    state = place(state, escort2.id, home, player);
    state = {
      ...state,
      cards: state.cards.map((c) => (c.id === newcomer.id ? { ...c, zone: "hand" as const, controller: player } : c)),
    };
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: newcomer.id, locationId: nextStreet });
  });

  it("exploits her active play grant to place a Rebel card directly at a Secure location", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const oppositionLeader = findByDefRef(state, "Opposition Leader");
    const player = oppositionLeader.controller!;
    const home = state.board[0]!.id; // Street
    const hq = state.board.find((l) => l.name === "HQ")!.id;
    const escort1 = state.cards.find((c) => c.defRef === "Mr. Lucky")!;
    const escort2 = state.cards.find((c) => c.defRef === "Gunman")!;
    const newcomer = state.cards.find((c) => c.defRef === "Rebel Soldier")!; // Street/Public only — normally can't reach HQ
    state = place(state, oppositionLeader.id, home, player); // escort cap already met, so self-escort doesn't intercept
    state = place(state, escort1.id, home, player);
    state = place(state, escort2.id, home, player);
    state = {
      ...state,
      cards: state.cards.map((c) => (c.id === newcomer.id ? { ...c, zone: "hand" as const, controller: player } : c)),
    };
    state = {
      ...state,
      turn: {
        ...state.turn,
        currentPlayerId: player,
        phase: "action",
        actionsRemaining: 0,
        restrictedAction: { kind: "play", amount: 2, faction: "Rebel", locationId: null, ignoreLocationRestrictions: true },
      },
    };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: newcomer.id, locationId: hq });
  });
});

describe("decideBotAction: Heir Apparent's strategy", () => {
  it("deploys to a central location once it's escorted (protection available)", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const heirApparent = findByDefRef(state, "Heir Apparent");
    const player = heirApparent.controller!;
    const central = state.board[2]!.id; // second Street — board position 3 (1-indexed)
    const escort = state.cards.find((c) => c.defRef === "Secret Police")!; // Regime, non-Protected
    state = place(state, escort.id, central, player);
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "playCard", cardId: heirApparent.id, locationId: central });
  });

  it("does not prioritize deploying before a central location is escorted", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const heirApparent = findByDefRef(state, "Heir Apparent");
    const player = heirApparent.controller!;
    const central = state.board[2]!.id;
    const otherCentral = state.board[3]!.id; // Arena — board position 4 (1-indexed)
    state = { ...state, turn: { ...state.turn, currentPlayerId: player, phase: "action" } };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).not.toMatchObject({ type: "playCard", cardId: heirApparent.id, locationId: central });
    expect(action).not.toMatchObject({ type: "playCard", cardId: heirApparent.id, locationId: otherCentral });
  });

  it("prefers eliminating a rival leader over a non-priority opposing card", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const heirApparent = findByDefRef(state, "Heir Apparent");
    const player = heirApparent.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const rivalLeader = findByDefRef(state, "Wife"); // Regime, Protected — unescorted here, so legal
    const decoyTarget = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, heirApparent.id, loc, player);
    state = place(state, rivalLeader.id, loc, other); // revealed (place defaults faceUp: true)
    state = place(state, decoyTarget.id, loc, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: heirApparent.id,
      actingPlayerId: player,
      abilityIndex: 1,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [rivalLeader.id] });
  });

  it("prefers eliminating a still-hidden card over a visible non-priority one", () => {
    let state = freshGame(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const heirApparent = findByDefRef(state, "Heir Apparent");
    const player = heirApparent.controller!;
    const other = state.players.find((p) => p.id !== player)!.id;
    const loc = state.board[0]!.id;
    const hiddenCard = state.cards.find((c) => c.defRef === "Secret Police")!; // Blend, non-leader
    const decoyTarget = state.cards.find((c) => c.defRef === "Rebel Soldier")!;
    state = place(state, heirApparent.id, loc, player);
    state = place(state, hiddenCard.id, loc, other, false); // face-down
    state = place(state, decoyTarget.id, loc, other);

    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: heirApparent.id,
      actingPlayerId: player,
      abilityIndex: 1,
      locationId: loc,
      targetIds: null,
    };
    state = { ...state, resolutionStack: [frame] };
    const filtered = filterForPlayer(state, player);

    const action = decideBotAction(filtered, player, cardData, zero);
    expect(action).toEqual({ type: "chooseTargets", targetIds: [hiddenCard.id] });
  });
});
