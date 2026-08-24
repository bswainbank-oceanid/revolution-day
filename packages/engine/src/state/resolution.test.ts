import { describe, expect, it } from "vitest";
import type {
  AbilityResolutionFrame,
  AlarmResolutionFrame,
  MotorcadeInterceptionWindowFrame,
  ProtectedTargetingWindowFrame,
  ReactivePassiveWindowFrame,
  ResolutionFrame,
} from "./resolution";

// These are still pure type definitions with no reducer logic yet — this
// test exists to confirm the discriminated union narrows exhaustively
// (a compile-time check) and that each frame shape is constructible.
function describeFrame(frame: ResolutionFrame): string {
  switch (frame.kind) {
    case "abilityResolution":
      return frame.targetIds === null ? "ability, untargeted" : "ability, targeted";
    case "alarmResolution":
      return `alarm at ${frame.locationId}`;
    case "protectedTargetingWindow":
      return `reveal window for ${frame.declaredTargetIds.join(",")}`;
    case "motorcadeInterceptionWindow":
      return `intercept window at ${frame.presidentLocationId}`;
    case "reactivePassiveWindow":
      return `reactive window at ${frame.locationId}`;
  }
}

describe("resolution frames", () => {
  it("AbilityResolutionFrame starts untargeted until the ability resumes", () => {
    const frame: AbilityResolutionFrame = {
      kind: "abilityResolution",
      sourceCardId: "card-1",
      actingPlayerId: "p1",
      abilityIndex: 0,
      locationId: "loc-0",
      targetIds: null,
    };
    expect(describeFrame(frame)).toBe("ability, untargeted");
  });

  it("AlarmResolutionFrame carries a precomputed order ending with the triggering player", () => {
    const frame: AlarmResolutionFrame = {
      kind: "alarmResolution",
      triggeringCardId: "card-1",
      triggeringPlayerId: "p1",
      locationId: "loc-0",
      order: ["p2", "p3", "p1"],
      nextIndex: 0,
    };
    expect(frame.order.at(-1)).toBe(frame.triggeringPlayerId);
  });

  it("ProtectedTargetingWindowFrame skips the declaring player from its order", () => {
    const frame: ProtectedTargetingWindowFrame = {
      kind: "protectedTargetingWindow",
      declaringPlayerId: "p1",
      declaredTargetIds: ["card-president"],
      locationId: "loc-0",
      order: ["p2", "p3"],
      nextIndex: 0,
      anyRevealed: false,
    };
    expect(frame.order).not.toContain(frame.declaringPlayerId);
  });

  it("MotorcadeInterceptionWindowFrame's order is only eligible interceptors", () => {
    const frame: MotorcadeInterceptionWindowFrame = {
      kind: "motorcadeInterceptionWindow",
      actingPlayerId: "p1",
      presidentLocationId: "loc-0",
      order: ["p2"],
      nextIndex: 0,
    };
    expect(describeFrame(frame)).toBe("intercept window at loc-0");
  });

  it("ReactivePassiveWindowFrame carries the captured location/faction, not the source card's own", () => {
    const frame: ReactivePassiveWindowFrame = {
      kind: "reactivePassiveWindow",
      sourceCardId: "card-1",
      locationId: "loc-0",
      faction: "Rebel",
      order: ["p1"],
      nextIndex: 0,
    };
    expect(describeFrame(frame)).toBe("reactive window at loc-0");
  });
});
