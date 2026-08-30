// Single source of truth for every pacing delay in the client —
// useTurnPlayback's bot-turn choreography (camera moves, Card Viewer
// beats) reads this per beat instead of hardcoding its own timeout
// ("uniform 1 second per visual beat" per BUILD_PLAN.md, since raised to
// 2s). Set to 0 (instant) during automated verification (Playwright) so
// slow real-time waits don't stack up across many simulated turns — drop
// it back to 0 for that; 2000 is the real gameplay pace.
export const PACING_DELAY_MS: number = 2000;
