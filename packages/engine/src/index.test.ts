import { describe, expect, it } from "vitest";
import { getEngineInfo, cardData } from "./index";

describe("engine card data loading", () => {
  it("loads the expected game metadata", () => {
    const info = getEngineInfo();
    expect(info.game).toBe("Revolution Day");
    expect(info.leaderCount).toBe(8);
    expect(info.locations).toHaveLength(6);
  });

  it("types leaders and non-leader cards", () => {
    const headOfSecurity = cardData.leaders.find((l) => l.name === "Head of Security");
    expect(headOfSecurity?.faction).toBe("Regime");
    expect(cardData.non_leader_cards.length).toBeGreaterThan(0);
  });
});
