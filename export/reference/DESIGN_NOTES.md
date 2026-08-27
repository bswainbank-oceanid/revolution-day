# Revolution Day — Game Table UI Design Notes
Status: **Locked**. Target: desktop/laptop, landscape, designed at 1920x1080.

Reference images (all in this export): `location_view_v6_final.png` (3-5 players, the
common case), `location_view_6players_final.png`, `location_view_8players_final.png`
(stress tests), `location_view_president_final.png` (President on a tile),
`city_view_v2_final.png` (President on the board), `city_view_offboard_final.png`
(President not yet in play). See `SEATING_SPEC.md` for the seating rules in full detail —
this doc summarizes them plus everything else.

## Screen regions (fixed pixel layout at 1920x1080)

| Region | Bounds | Contents |
|---|---|---|
| Top ribbon | y: 0-175 | Turn/deck indicator (x: 0-480) + one panel per player (centered in the rest) |
| Left column | x: 0-480, y: 175-1080 (full height) | Card Viewer (top) + Activate Ability (bottom) |
| Center pane | x: 480-1660, y: 175-890 | Location View or City View (toggle) |
| Right column | x: 1660-1920, y: 175-1080 (full height) | Game Log (top half) + Game Chat (bottom half) |
| Bottom strip | x: 480-1660, y: 890-1080 | Your Hand + Actions Remaining / Draw Card |

Left column and right column both run the *full* height of the screen, top to bottom —
only the center pane and bottom strip share the lower portion of the middle of the screen.

## Top ribbon

- Turn/deck indicator lives here (not in the left column) — "TURN N", a small draw-deck
  stack, and cards-remaining count. Keeping it in the ribbon frees the entire left column
  for the Card Viewer.
- One panel per player, centered as a group in the remaining ribbon width. Active player's
  panel gets a gold border + "CURRENT TURN" tag.
- Every player's hand — including the local player's own — shows as a **uniform face-down
  card-back fan with a count label**. No one gets to see anyone's hand contents from the
  ribbon; the count label sits *below* the fan, left-justified, with enough vertical room
  in the panel that it never overlaps the cards above it.
- Scales down to 6-8 players by shrinking panel width and font sizes proportionally; all
  tested up to 8 without any panel needing to wrap or truncate.

## Left column

- **Card Viewer**: shows "Controlled by: Player N — Location" *above* the card image, then
  the card itself at **true maximized size** — fit to whichever dimension (column width or
  remaining height) is the binding constraint, never shrunk further than that. At the
  480px column width this renders around 437x597px — every ability line and the win
  conditions box are legible without zooming.
- **Activate Ability**: sits directly under the viewer, in a footer strip that lines up
  with the bottom strip's row across the rest of the screen. One button per activatable
  ability on the currently-viewed card, stacked vertically. Cards with no abilities (e.g.
  the President) show "No abilities — Protected" instead of an empty box.

## Center pane — Location View

Full seating logic is in `SEATING_SPEC.md`. Summary: the **local player is always anchored
bottom-center** (their seat is drawn even when empty), other players fill in **clockwise**
around 4 more named seats (BL, TL, TR, BR), and **top-center is permanently skipped** to
keep the tile's own art/badge clear. Cards within a seat render as a heavily-overlapping
stack (~26-30px offset) with a player-colored border and one label — legibility of
individual cards is what the Card Viewer is for, not this view.

**Overflow (6+ players):** `BOTTOM_CENTER` shares side-by-side; the two *lower* corners
(BL, BR) have real room to stack a second cluster below them; the two *upper* corners
(TL, TR) sit close against the ribbon with no headroom and must stay single-occupant no
matter the player count. This is a deliberate, tested exception to strict clockwise order.

**The President**, when at this location, rests directly on the tile as a small tilted
card (~46-60px wide, roughly -6° to 8° rotation) positioned clear of the tile's own badge
— not overlapping it. This reuses the same "card resting on the tile" treatment built for
the rulebook's Sample of Play illustration, for visual consistency across print and app.

## Center pane — City View

- All 6 locations in a 3x2 grid, fixed reading order: Street / HQ / Street (top row),
  Arena / Street / Palace (bottom row) — matches the board's physical linear sequence.
- Each tile carries a **number badge (1-6)** in its top-left corner, since the grid
  layout alone doesn't convey the linear order the 3x2 arrangement obscures.
- Player presence per location is **shrunk to small colored count-chips** below each tile
  (player color + card count), not full card art. A location with nobody present just
  reads "No cards here." This is the key difference from Location View: City View is a
  glanceable overview, not a detail view.
- **The President** gets the same small-tilted-card treatment as Location View when he's
  on one of the 6 tiles. When he's **not yet in play**, that card instead sits to the
  **left of tile #1**, labeled "OFF BOARD." When he **survives** (escapes past the
  Palace), the same card belongs to the **right of tile #6** — not yet rendered as a
  screenshot, but it's the exact mirror of the "not yet in play" treatment and uses the
  same margin space, already confirmed clear of the pane boundary.
- A text status line under the "CITY VIEW" header always states the President's status in
  words too ("PRESIDENT: Street (2nd)" / "PRESIDENT: Not yet in play"), so his position is
  never conveyed by the visual marker alone.
- Only the center pane differs between Location View and City View — ribbon, left column,
  right column, and bottom strip are identical in both modes.

## Right column

- Game Log (top half) and Game Chat (bottom half). Game Chat's panel extends all the way
  to the physical bottom of the screen — it does not stop at the same boundary as the
  center pane / bottom strip.

## Bottom strip

- "YOUR HAND" label renders in **the local player's own color** (a quiet, persistent color
  cue for whose screen this is) — not a neutral gray like other UI labels.
- Real face-up cards from the local player's hand, left-aligned within the hand zone.
- "Actions Remaining" counter + "Draw Card" button, positioned in the remaining width to
  the right of the hand.

## Color system

- Player colors are fixed per player for the whole game (not tied to seat position):
  crimson, cobalt, green, lemon, violet, amber for players 1-6. **Players 7-8 need two
  additional colors** (a teal and a magenta were used for the 8-player stress test) —
  these aren't yet chosen as "final" brand colors, just placeholders that read as visually
  distinct from the first 6.
- All UI chrome (panels, borders, dim text) reuses the same neutral dark palette as the
  print materials, so the app doesn't feel like a different product from the physical game.

## Bugs caught during this session (documented so the same mistakes aren't repeated)

Every one of these was caught by rendering and either visually inspecting or adding a
programmatic boundary/overlap check — not assumed correct from the code alone:

1. Ribbon: card-count label was positioned *inside* the vertical span of the fanned cards
   above it (overlap). Fixed by moving it below the fan with real clearance.
2. Left column: Activate Ability buttons overflowed past the screen bottom and were
   silently hidden behind the bottom strip panel drawn on top. Fixed by shrinking the
   viewer and adding an explicit `assert` on the column's total content height.
3. Card Viewer was width-bound at the original 260px column width, using only about half
   its available height. Rather than centering it in dead space, widened the column so
   the card genuinely fills the space in both dimensions.
4. Location View: a 2-card cluster's width wasn't accounted for when computing clearance
   from the tile, causing real pixel overlap — happened twice, at different stages of the
   redesign, before a reusable clearance formula was adopted.
5. The local player's "bottom-center" label rendered inside the tile's own bottom edge
   because the vertical gap assumed for that seat didn't leave room for the label text
   above the cards.
6. When BL and TL both needed to hold two stacked players (8-player case), they shared an
   x-coordinate with too little vertical separation and collided.
7. First attempt at giving TL/TR "symmetric" stacking room (mirroring BL/BR) pushed a
   cluster 163px into the ribbon — TL/TR sit right against the ribbon and have no headroom,
   unlike the lower corners. Overflow was rerouted to BL/BR instead.
8. City View: row 1's player-count chip badges overlapped row 2's location name labels
   (both nearly touching with only ~70px of row gap). Fixed by widening the row gap and
   shrinking tile size slightly to compensate, verified with an assertion.

The recurring lesson: **always compute clearance from the actual rendered content size
(cluster width, label height, column width), never from an assumed/eyeballed gap** — and
check it in code, not just by looking at the image once.

## Open items / not yet resolved

- President "escaped" state (right of Palace) — logic confirmed, not yet rendered as a
  standalone screenshot.
- 7th and 8th player colors are placeholders, not finalized brand colors.
- No behavior defined yet for a location somehow holding 9+ occupants (shouldn't be
  reachable at an 8-player max across 6 locations, but not explicitly validated).
- "Your Hand" label color fix was applied to both City View screens; **Location View's
  reference screenshots predate this fix** and should be regenerated to match before
  treating all screens as fully consistent.
