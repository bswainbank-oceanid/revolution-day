// Single source of truth for every pacing delay in the client —
// useTurnPlayback's bot-turn choreography (camera moves, Card Viewer
// beats) reads this per beat instead of hardcoding its own timeout
// ("uniform 1 second per visual beat" per BUILD_PLAN.md). Defaulted to 0
// (instant) so automated verification (Playwright) never has to sit
// through real per-beat waits — slow, real-time waits stacking up across
// many simulated turns is exactly what made this session's own
// verification runs painfully slow. Bump this locally (e.g. to 600-1000)
// to actually watch the choreography play out.
export const PACING_DELAY_MS = 0;
