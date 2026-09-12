# Revolution Day client — full UI rebuild against the locked mockups

Status: **All 9 steps complete and verified.** Step 1: filtered-targeting logic
promoted into `packages/engine`, `packages/bots/src/targetPool.ts` deleted. Step 2:
the fixed 1920x1080 scaling canvas (`GameCanvas.tsx`) with the 5 regions laid out
exactly per `DESIGN_NOTES.md`'s pixel table. Step 3: every region rendering real
game data (`TurnRibbon`, `CardViewer`, `ActivateAbilityBox`, `CityView`,
`LocationView` incl. `SEATING_SPEC.md`'s seat-assignment table, `GameLog`,
`GameChat` stub, `HandStrip`, `ActionsBox`). Player labels are "Player N"/"Bot N"
by seat (play) order + "(You)" for the local player, not raw player IDs — a
refinement made during step 3, applied via a shared `playerLabel` helper in
`players.ts`. One real bug found and fixed during step 3 verification: the
President's off-board/survived marker was positioned with a negative offset
that pushed it into the left column's space instead of staying inside the
center pane — fixed by giving `.city-grid` real side margins.

Step 4: real view navigation via a new `useViewNavigation` hook — City View
tile click goes to that location's Location View, clicking the brown
background outside the location image returns to City View, replacing the
temporary debug toggle entirely. Also absorbed the two related interactions
that didn't get their own numbered step: clicking a card (a hand card, or an
in-play card's `MiniCard` in Location View) selects it into the Card Viewer,
and selecting an in-play card also navigates to its location if you weren't
already there (`App.tsx`'s `selectCard`, shared by both). `CardViewer`'s
controller label is now computed for whichever card is actually selected
(`"You"` vs. `playerLabel(...)`), not hardcoded to the human's leader.
Verified live: City↔Location navigation, hand-card click updating the Card
Viewer, no console errors. Mini-card click in Location View shares the exact
same handler as the hand-card click (already verified) but couldn't be
live-exercised itself — a fresh game has 0 cards in play until real actions
exist (step 5), since bots don't play cards on their own first turn either.
GameScreen.tsx (the first slice's ad hoc layout) is disconnected but not yet
deleted.

Step 5: core turn actions minus targeting. `useGame.ts`'s bot-turn loop
(`runBotsUntilHumanOrOver`) became `runUntilHumanDecision` — it now also
auto-submits the human's mandatory start-of-turn draw (`turn.phase ===
"draw"`) and forced end-turn (`actionsRemaining === 0`) the moment either
condition holds, alongside the existing bot-turn stepping, so neither is a
button. `ActionsBox` gained real voluntary Draw/End Turn buttons. Drag-and-
drop play/move is native HTML5 DnD, driven by one shared `draggedCard`
state in `App.tsx`: a card can be dragged from the hand strip, an in-play
`MiniCard`, or the Card Viewer (once a card is selected there) — all three
share one `canDrag(card)` check (own card, real turn action available,
not Motorcade). `allowedDropLocationIds` is computed per drag from the
engine directly (`getAllowedLocationTypes` for a hand card, `adjacent
LocationIds` for an in-play card) so highlighting is exact, not guessed.
City View tiles and the Location View location image both accept drops
and highlight when they're legal for whatever's being dragged. Also fixed
a small pre-existing GameLog grammar bug ("You ended their turn.") that
step 5 made reachable by a human action for the first time. The app is
now genuinely playable — a full human turn (draw, play, move, end turn)
works end to end against bots, with only ability activation/targeting
still missing (step 6).

Verified live: mandatory draw/forced end-turn firing with no click across
several turns, voluntary Draw and End Turn buttons, a hand-card drag-drop
play (onto a City View tile), and an in-play-card drag-drop move via the
Card Viewer onto a highlighted adjacent tile (dragging the in-Location-
View MiniCard itself can't reach an adjacent tile without navigating
mid-drag, which native DnD doesn't support here — the Card Viewer is the
real path for moves, and is already wired for it).

Step 6: target selection. New `targetDecision.ts` (pure logic: is the
current ability effect trivial/auto-advanceable, or does it need a real
card/location pick, plus button-gating via `abilityIsUsable` so a click
never leads into a guaranteed dead end) and `useTargetSelection.ts` (the
live React state — selection, the Choose Targets/View Cards toggle,
response staging for `useResponse`). `useGame.ts`'s auto-advance loop now
also skips every trivial ability effect (self/binding target, random
selection, "all" mode, a forced/empty pool, Wife's president-only target)
with no click, extending step 5's mandatory-draw/forced-end-turn
automation. `ActivateAbilityBox` and `ActionsBox` are now fully live:
real Activate/Response/Intercept buttons, the Choose Targets/View Cards
toggle, Done for variable-count picks, Pass for alarm/intercept windows.
`CityView`, `LocationView`, `MiniCard`, and `HandStrip` all gained real
target highlighting and click-to-toggle, sourced directly from the
engine's own `candidateInPlayCards`/`candidateHandCards`/
`presidentIsLegalTarget` (no separate highlighting logic to drift).
Navigation auto-follows a single-location-locked pick and force-shows
City View for a location-only pick (Traffic Cop's destination,
Anarchist's alarm location).

`activateRemote` (Head of Security's 1st ability, Guerrilla Commander's
1st, Puppet-Master's 2nd — nested card+ability picking: pick any eligible
card anywhere on the board, then pick one of *that card's* own usable
Activate abilities, submitted together as one `chooseTargets` action with
both `targetIds` and `remoteAbilityIndex`) is now supported, as a two-stage
pick within `useTargetSelection.ts` (stage 1 reuses the normal `cardPick`
machinery; stage 2 shows the picked card's own ability buttons via
`usableActivateAbilities`, which doesn't assume `card.controller ===
actingPlayerId`). It carries one narrower, deliberate remaining sub-gap: a
still-face-down (Blend) card not controlled by the acting player can never
be offered as a candidate, since the client can't know a hidden card's own
abilities before the one atomic action that both picks and reveals it —
there's no "reveal-then-choose" frame for this verb. Bots are unaffected
(they see unfiltered state).

Deliberately out of scope, gated off at the ability-button level so the
human can never reach an unsupported resolution state through their own
choice (bots are unaffected — they decide these independently): Opposition
Leader's "place 2 rebels at any locations" (its 1st ability — per-target
location pairing). Every other Activate/Response ability in the current
28-card set is fully interactive, including multi-effect sequences
(Master Assassin, Secret Police, Suicide Bomber) and every resolution-stack
window (alarm response, protected-targeting reveal, Motorcade interception,
reactive-passive play).

Verified live via extended Playwright runs playing many real turns against
bots: multiple real ability activations resolving correctly end to end
(including Suicide Bomber's full 3-step auto-advancing sequence with zero
clicks), an alarm response, and a "choose 1 of 4 eligible" exact-count
pick with correct highlighting and auto-submit. No console errors in any
run.

Step 7: playback/choreography. New `useTurnPlayback.ts` replays the
already-known sequence of `LogEntry.resultingState`s one at a time
(there's no server-side streaming — a whole bot turn, or a whole batch of
auto-advanced steps, always arrives in one go) rather than jumping
straight to the final state. Only bot-attributed entries get this
treatment — a human-attributed entry (the player's own click, or an
auto-advanced mandatory draw/forced end-turn/trivial target choice)
reveals instantly. For each bot-turn beat: the camera follows the locked
priority order (explicit destination in the action → the President's
location if it changed → a card the action names → the resolution frame
active before the action → no signal at all; `endTurn` always goes to
City View), and the Card Viewer shows a newly-played/drawn card, or steps
through a multi-target action's targets individually before reverting to
the acting/source card (only meaningful for `chooseTargets`/`useResponse`,
which have an unambiguous source — a reveal/reactive window just shows
its targets). Red-X-on-eliminated needed no new code — `CardViewer`'s
existing eliminated check already applies to whatever card playback is
showing. `ActivateAbilityBox`/`ActionsBox`/navigation all go read-only
("Watching the turn play out…") for the window playback is stepping,
and the pre-existing target-selection navigation-lock effect explicitly
defers to it (both would otherwise fight over the camera).

Prep work for this step: pacing itself is a client-only setting
(`pacing.ts`'s `PACING_DELAY_MS`, not part of GameState), added before
step 7 started at the user's request specifically so automated
verification never has to sit through real per-beat waits. Committed at
`0` (instant); bump it locally (600-1000ms) to actually watch the
choreography.

Verified live via Playwright at both `PACING_DELAY_MS=0` (fast functional
runs across many turns, confirming playback always converges back to
human control with zero dead ends, including a bot's Suicide-Bomber-style
multi-step sequence and an alarm-triggering ability resolving cleanly) and
a temporarily-raised delay (confirming the camera and Card Viewer
choreography visually — caught a real mid-playback frame: a Motorcade's
first move onto the board correctly followed via the "President's
location changed" priority rule, with the Motorcade card shown in the
Card Viewer and both boxes reading "Watching the turn play out…"). Zero
console errors in every run.

Step 8: blend/reveal treatment. New `art.ts` helpers `isOwnBlended(card,
viewerId)` (a card the viewer controls that's currently face-down —
per-instance runtime state, not the permanent printed Blend attribute)
and `cardFaceUrl(card, viewerId)` (a plain back for anyone else's
blended card — the client genuinely has no defRef for it — true art
otherwise, including the viewer's own blended cards). `CardViewer` and
`MiniCard` both switched from the old blanket "face-down → always a
back" rule to this, and both render the same small eye-badge overlay
(upper-right of the card art, clear of the printed name/icons/text) when
`isOwnBlended` is true — one shared helper so the two never drift, per
the locked design. `MiniCard` needed a wrapping `<span>` to host the
absolutely-positioned badge (previously a bare `<img>`).

Verified live: played a Blend-attribute card (Puppet-Master) from hand,
confirmed the eye badge renders correctly in both the Location View
MiniCard and the Card Viewer, showing the true art with the badge clearly
distinct from the card's own printed Blend-attribute icon. Zero console
errors.

Step 9: `GameOverScreen` integration + final pass. It wasn't wired into
`App.tsx` at all before this — now `session.gameOver` (once `playback`
has finished narrating any bot turn that ended the game, so the human
still gets to watch what happened rather than have it snap away) replaces
the whole canvas with the results table and a "Play Again" button
(reusing `startNewGame`). `GameOverScreen` itself carried over from the
first slice essentially as-is, per the plan, with one real change: player
labels via the shared `playerLabel` helper instead of raw player IDs,
matching every other screen. `GameChat` stays the stub it already was
from step 3 — no chat feature is being built.

Also deleted the first slice's now-fully-superseded files (`GameScreen.tsx`,
`Board.tsx`, `Hand.tsx`, `Card.tsx`) — they were already disconnected from
`App.tsx` but still compiled as part of the package, and had started
actively breaking the build (a stale `GameOverScreen` prop signature)
once this step changed that component's props. Pruned their exclusively-
owned dead CSS from `App.css` too, verified class-by-class against every
surviving file before removal (kept `.error`/`.hint`/the `.new-game`
button rules, which turned out to be shared).

Verified live: reached real Game Over states via extended bot-vs-bot-vs-
human play (both a "nobody won" and a "Winners: Bot N" outcome), confirmed
correct player labels and win/loss predicate rendering, and confirmed
"Play Again" correctly starts a fresh game. One round of flaky Playwright
runs during this turned out to be ~49 orphaned Chromium processes
accumulated from this session's own earlier crashed verification
scripts, not a real bug — confirmed by a clean re-run immediately after
killing them. Zero console errors in every clean run.

**The full 9-step client rebuild is now complete.** The app is genuinely
playable end to end: draw, play, move, activate abilities, respond to
alarms, navigate the board, watch bot turns play out with real
camera/Card-Viewer choreography, and reach a properly-labeled Game Over
screen. `activateRemote` support was added later (see above). One
deliberately-scoped-out gap remains documented above (Opposition Leader's
per-target "any location" play) — gated off at the ability-button level
rather than half-built.

## Context

The first client slice (`packages/client`) proved the loop end-to-end (create game, take a full turn including an ability, bots auto-play, game-over screen) but used an ad hoc layout — a flat board of locations with inline click-to-select. The user has since supplied real, "Locked" UI mockups and specs (`export/reference/DESIGN_NOTES.md`, `export/reference/SEATING_SPEC.md`, and 6 reference screenshots) and we've spent a full design conversation resolving every interaction question the mockups themselves don't answer (they show *viewing* state beautifully but no actual action-taking). This plan replaces the ad hoc layout with the real one and implements the full interaction model as designed. Nothing here is still open — every decision below was explicitly made in conversation, not inferred.

## Locked design decisions (reference while building — don't re-derive)

**Layout** (`DESIGN_NOTES.md`'s region table, fixed proportions designed at 1920×1080 — build as a fixed-aspect canvas that scales to fit the viewport, matching a game UI rather than a fluid webpage): top ribbon (turn/deck + one panel per player), left column (Card Viewer + Activate Ability box, full height), center pane (City View ⟷ Location View), right column (Game Log + Game Chat, full height), bottom strip (hand + Actions box).

**View navigation**: starts in City View. Click a location tile → Location View for it. Click the brown background outside the location image → back to City View. Free navigation during the human's own turn.

**Drag and drop**: dragging a card from hand (or the Card Viewer once selected) onto a location plays it there; dragging an in-play card onto a location moves it there (adjacency-only, and — unlike ability targeting — this can be highlighted with 100% accuracy since adjacency is pure board-position math). Native HTML5 DnD, no new dependency.

**Target highlighting**: real, not blind trial-and-error. The candidate-filtering logic already built and tested for bots (`asCardInstance`, `knownFaction`, `candidateInPlayCards`, `candidateHandCards`, `presidentIsLegalTarget`, originally in `packages/bots/src/targetPool.ts`) is now **promoted into `packages/engine`** (`packages/engine/src/effects/filteredTargeting.ts`, exported from `packages/engine/src/index.ts`) so bots and client consume one implementation instead of two copies that can drift (a real risk — this logic already had a live bug found and fixed once this session). **Done as of step 1** — `packages/bots/src/targetPool.ts` is deleted; `decide.ts` imports from `@rev-day/engine` directly.

**Action → UI box mapping**:
- *Activate Ability box* (left column): anything triggered through the currently-selected card — `activateAbility`, `useResponse`, `interceptMotorcade`. Clicking an ability button fires immediately if it needs no further target; otherwise it opens target selection.
- *Actions box* (bottom strip): general, non-card-specific flow control — voluntary `draw`, voluntary `endTurn`, all the `pass*` variants, and `Done` for variable-count target selections.
- **No confirms anywhere.** An exact-count target selection (including a fixed count >1, like Master Assassin's "eliminate exactly 2") auto-submits the instant the count is satisfied — no button. A variable-count selection (range, unbounded, "all you want") shows a `Done` button in the Actions box instead, since there's no other way to know when the player's finished.
- **Mandatory draw and forced end-turn (actions remaining hits 0) fire automatically**, no click. Voluntary draw and voluntary early end-turn stay real buttons (genuine choices).

**Target selection mode** (inside the Activate Ability box, once an ability/response needing targets is active): a **Choose Targets / View Cards** toggle.
- *Choose Targets*: clicking a card toggles it as a target; Card Viewer content does **not** change. Navigation locks to the ability's own target location scope when that scope is location-bound (`location: "self"` etc.); abilities with no location constraint (Wife's President target, remote activation's "any location") leave navigation free even here.
- *View Cards*: free navigation and click-to-inspect in the Card Viewer, purely for looking — zero effect on the pending selection or game state. Selections persist across toggling.

**Camera tracking during bot turns** (`useTurnPlayback`, new): steps through each bot action one at a time (already available as `logged[]` from `botTurn` — currently discarded in favor of jumping straight to the final state) with a uniform **1 second per visual beat**. Priority order for where the camera goes on each step:
1. Explicit destination in the action (`playCard.locationId`, `moveCard.toLocationId`, `playMotorcade.moveToLocationId`, `chooseTargets.locationIds[0]`).
2. The President's location, if it changed this step.
3. A card the action names (`cardId`, or the first `targetId`) — look up its location in the resulting state.
4. The resolution frame active *before* this action — its own `locationId`/`presidentLocationId` (every frame kind carries one).
5. No signal (`draw`) — camera doesn't move. `endTurn` is a special case: **always goes to City View**, not "no move."

**Card Viewer sequencing during playback**, per step: a newly-drawn/newly-played card gets shown (1s beat); a targeting action shows each target **individually** in multi-target cases (one 1s beat per target), then one beat reverting to the acting/source card. Eliminated cards get a **red X over the portrait**, wherever rendered.

**Pacing**: 1 second per human-visible turn end too — after the human's last action, wait 1s before the bot sequence starts. Manual navigation is locked out while `useTurnPlayback` is actively stepping (it owns the camera then); free again once control returns to the human.

**Blended/revealed card display**:
- An opponent's blended card is **always** a plain back with the controller's player-color border — in Location View, *and* even when selected/shown in the Card Viewer during a targeting sequence (the client genuinely has no `defRef` for it; `filterForPlayer` never sends one).
- **Your own** blended cards show their true identity (Card Viewer already gets real `defRef` for own cards regardless of `faceUp`) but get a distinct treatment so it's clear they're currently hidden from everyone else: a small eye icon badge in the **upper-right of the portrait art**, positioned to clear the ability text/name/attribute icons — same badge, same position, in both the Card Viewer (full-size) and the small card renderer used in Location View clusters/hand. This is per-instance runtime state, not the permanent printed Blend-attribute icon — a shared helper (`isOwnBlended(card, viewerId)`) alongside `art.ts` drives it so `CardViewer` and the small-card renderer don't duplicate the check.

**Component tree**:
- Hooks: `useGame` (existing, extended to expose the step sequence rather than just the final state), `useTurnPlayback` (new — camera/Card-Viewer choreography above), `useViewNavigation` (new — City/Location toggle + which location), `useTargetSelection` (new — Choose Targets/View Cards, selection set, auto-submit/Done, highlighting). `decider.ts`/`api.ts`/`art.ts` carry over as-is.
- Visual, by region: `TurnRibbon` (`DeckIndicator` + `PlayerPanel`×N) · `CardViewer` + `ActivateAbilityBox` · `CityView` (`LocationTile`×6) + `LocationView` (`PlayerCluster`×seats, per `SEATING_SPEC.md`'s clockwise/overflow rules) · `GameLog` + `GameChat` (stubbed empty) · `HandStrip` + `ActionsBox`.
- Replaced: `Board.tsx`, `Hand.tsx`, `Card.tsx` (small thumbnail), most of `GameScreen.tsx`'s inline logic. Kept close to as-is: `GameOverScreen.tsx`.

## Build order (checkpointable, matches the phases discussed)

1. ✅ **Promote filtered-targeting logic** into `packages/engine`; delete `packages/bots/src/targetPool.ts`, repoint `decide.ts`'s imports. Existing bots/engine test suites pass unchanged (pure relocation, same behavior) — verified.
2. **Layout skeleton**: the 5-region fixed-canvas CSS grid, empty regions, confirmed against `DESIGN_NOTES.md`'s pixel bounds.
3. **Static content pass**: every region rendering real game data with no interactivity yet (ribbon, City View, Location View seating per `SEATING_SPEC.md`, Card Viewer showing whatever's selected, Game Log formatting `logged` entries, hand strip) — proves the visual language before wiring behavior.
4. **View navigation**: `useViewNavigation`, tile clicks, brown-background click.
5. **Core turn actions minus targeting**: automatic mandatory draw/forced end-turn, voluntary draw/end-turn buttons, drag-and-drop play/move with accurate adjacency highlighting for moves.
6. **Target selection**: `useTargetSelection`, the Choose Targets/View Cards toggle, real highlighting, auto-submit vs. `Done`, wired into both `activateAbility`→`chooseTargets` and the alarm/window resolution actions (`useResponse`, `revealBlended`, `interceptMotorcade`, `playReactive`) through the Activate Ability/Actions box split.
7. **Playback/choreography**: `useTurnPlayback` — full camera priority order, Card Viewer sequencing with per-target beats, red-X-on-eliminated, 1s pacing throughout, `endTurn`→City View, navigation lock during playback.
8. **Blend/reveal treatment**: `isOwnBlended` helper, eye-badge rendering in `CardViewer` and the small-card renderer.
9. **`GameOverScreen` integration + `GameChat` stub**, final pass.

## Known verification gap

The solo-vs-bots session is hardcoded to 1 human + 2 bots (3 players total) — `SEATING_SPEC.md`'s 6/7/8-player overflow rules (stacking at BL/BR, single-occupant TL/TR) will be built exactly per spec and cross-checked against the reference screenshots, but can't be *live*-verified in the running app without temporarily raising the bot count. Worth doing that temporarily during step 3/7 verification specifically to eyeball overflow, then reverting.

## Verification

- `npm run typecheck`/`lint` (and existing `npm run test` for engine/bots, to confirm step 1's relocation didn't change behavior) after each numbered step.
- Live browser verification at each meaningful checkpoint the same way the first slice was verified: headless Chromium (Playwright, set up in the scratch dir this session — `npm install playwright` + `npx playwright install chromium`), screenshots at each view/state, `console --errors`-equivalent (page/console error listeners) checked before calling a step done. Specifically verify: City View ⟷ Location View navigation, a drag-and-drop play and move, a full target-selection sequence (including the Choose Targets/View Cards toggle), a multi-target elimination's per-target playback beats, a full bot-turn sequence with camera follow, an own-blended-card's eye badge, and the game-over screen inside the new layout.
