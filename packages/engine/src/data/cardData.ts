import raw from "./card_data.json";
import type { CardData } from "../types";

// This file is a copy of `export/card_data.json`, the design team's
// authoritative source. If that file changes, re-copy it here
// (see repo root README for the sync step) rather than editing this copy.
export const cardData = raw as unknown as CardData;
