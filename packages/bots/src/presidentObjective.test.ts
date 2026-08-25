import { winConditions } from "@rev-day/engine";
import { describe, expect, it } from "vitest";
import { presidentObjectiveFor } from "./presidentObjective";

describe("presidentObjectiveFor", () => {
  it("wants him eliminated: Wife (presidentEliminatedAt)", () => {
    expect(presidentObjectiveFor("Wife", winConditions)).toBe("eliminate");
  });

  it("wants him eliminated: Guerrilla Commander (presidentStatus: eliminated)", () => {
    expect(presidentObjectiveFor("Guerrilla Commander", winConditions)).toBe("eliminate");
  });

  it("wants him eliminated: Master Assassin (eliminatedByControlled: president)", () => {
    expect(presidentObjectiveFor("Master Assassin", winConditions)).toBe("eliminate");
  });

  it("wants him protected: Head of Security (presidentStatus: notEliminated)", () => {
    expect(presidentObjectiveFor("Head of Security", winConditions)).toBe("protect");
  });

  it("is neutral for a leader whose conditions never mention him: Opposition Leader", () => {
    expect(presidentObjectiveFor("Opposition Leader", winConditions)).toBe("neutral");
  });

  it("is neutral for an unknown defRef", () => {
    expect(presidentObjectiveFor("Not A Real Leader", winConditions)).toBe("neutral");
  });
});
