import { describe, expect, it } from "vitest";
import type { AbilityDefinition } from "./dsl";

// These encode the two worked examples from the design conversation
// (rev_day_engine_design memory) exactly as agreed, to prove the DSL
// vocabulary actually captures them rather than being aspirational types.

const suicideBomberActivate: AbilityDefinition = {
  type: "Activate",
  alarm: true,
  effects: [
    // Forced, no player choice — added during design stress-testing.
    {
      verb: "reveal",
      target: {
        ref: "filter",
        location: { mode: "self" },
        blendState: "faceDown",
        hasAttribute: "Protected",
        count: { mode: "all" },
        selection: "playerChoice",
      },
    },
    // Primary pool exhausted fully before the fallback (Protected) pool
    // is touched — location-wide, not the standard per-faction check.
    {
      verb: "eliminate",
      target: {
        ref: "filter",
        location: { mode: "self" },
        count: { mode: "exact", value: 4 },
        selection: "random",
        randomPool: { pool: "unprotected", fallbackPool: "protected" },
      },
    },
    { verb: "eliminate", target: { ref: "self" } },
  ],
};

const secretPoliceActivate: AbilityDefinition = {
  type: "Activate",
  effects: [
    {
      verb: "reveal",
      target: {
        ref: "filter",
        location: { mode: "self" },
        blendState: "faceDown",
        count: { mode: "exact", value: 1 },
        selection: "playerChoice",
      },
      bind: "target",
    },
    {
      verb: "if",
      condition: {
        op: "equals",
        left: { source: "binding", binding: "target", field: "faction" },
        value: "Rebel",
      },
      then: [{ verb: "eliminate", target: { ref: "binding", binding: "target" } }],
      else: [
        {
          verb: "if",
          condition: {
            op: "equals",
            left: { source: "binding", binding: "target", field: "faction" },
            value: "Regime",
          },
          then: [{ verb: "eliminate", target: { ref: "self" } }],
        },
      ],
    },
  ],
};

describe("effect DSL — worked examples", () => {
  it("Suicide Bomber: forced reveal, then random-with-fallback, then self-eliminate", () => {
    expect(suicideBomberActivate.effects).toHaveLength(3);
    const [reveal, eliminate] = suicideBomberActivate.effects;
    expect(reveal).toMatchObject({ verb: "reveal" });
    expect(eliminate).toMatchObject({ verb: "eliminate" });
  });

  it("Secret Police: reveal-then-branch on the revealed faction", () => {
    const [, branch] = secretPoliceActivate.effects;
    expect(branch).toMatchObject({ verb: "if" });
  });
});
