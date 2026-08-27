# Location View — Player Seating Specification

Status: **Locked**. Reference implementations: `location_view_v6_final.png` (3 players),
`location_view_6players_final.png` (6 players), `location_view_8players_final.png` (8 players).

## Core rule

Each human player has their own client, so the seating layout is **relative to the viewer**,
not to turn order or player number:

- **The local (viewing) player is always in the same seat: bottom-center**, directly below
  the location tile. This seat is drawn even when the local player has no cards at the
  location being viewed — an empty labeled seat, never omitted — so "this is you" is never
  ambiguous.
- All other players are placed **clockwise from the local player's seat**, as if seated
  around a physical table.
- **Top-center is never used for a player.** It's the one position skipped in the rotation,
  so the location tile's own art/badge stays visually clear at the top of the pane with
  nothing competing for that space.

This gives **5 usable seats** total: `BOTTOM_CENTER` (local, fixed), `BL`, `TL`, `TR`, `BR`.

## Clockwise order

```
BOTTOM_CENTER (local) -> BL -> TL -> [skip TOP_CENTER] -> TR -> BR -> wraps back to BOTTOM_CENTER
```

For N total players (local + N-1 others), walk this order and assign one seat per player.
With 6 or more players, the walk laps back around to `BOTTOM_CENTER` and continues — see
overflow handling below.

## Rendering a seat's cards

- Cards render as heavily overlapping card-backs (a ~26-30px offset between cards, not full
  card width) — legibility of individual cards is *not* the goal here. The Card Viewer panel
  is where a player inspects a specific card in detail.
- Each card gets a thin border in that seat's assigned player color.
- One label above the cluster: `Player N` (or `Player N (You)` for the local seat).
- A seat with 2-5 cards should look visually "busy" — that's expected and fine.

## Overflow handling (6+ players)

With only 5 seats and up to 8 players, seats beyond the first lap must share a zone with
an earlier seat. **Not all zones are equally suited to sharing:**

- **`BOTTOM_CENTER` can share cleanly** — place the two occupants' clusters side by side. This
  is the first overflow seat (6th player) and always lands here by the clockwise walk.
- **`BL` and `BR` (the lower corners) have real vertical room to stack a second cluster**,
  because they sit well clear of both the ribbon (above) and the bottom strip (below). Route
  overflow here.
- **`TL` and `TR` (the upper corners) do NOT have room to stack.** They sit close to the top
  ribbon with very little headroom — attempting to stack a second cluster above them will
  collide with the ribbon. Keep these as single-occupant seats regardless of player count.

### Concrete assignment by player count

| Players | BOTTOM_CENTER | BL | TL | TR | BR |
|---|---|---|---|---|---|
| 2-5 | local (+1 if 6th wraps) | seat 2 | seat 3 | seat 4 | seat 5 |
| 6 | local **+ seat 6** (side by side) | seat 2 | seat 3 | seat 4 | seat 5 |
| 7 | local + seat 6 | seat 2 **+ seat 7** (stacked) | seat 3 | seat 4 | seat 5 |
| 8 | local + seat 6 | seat 2 + seat 7 (stacked) | seat 3 | seat 4 | seat 5 **+ seat 8** (stacked) |

In short: **the walk order is strictly clockwise, but when an overflow seat's "natural" clockwise
stop is `TL` or `TR`, redirect it to whichever of `BL`/`BR` doesn't have an overflow seat yet.**
This is a deliberate, documented exception to strict clockwise order, made for layout reasons —
not a bug.

## Things this spec does NOT yet cover

- A location with 9+ occupants at once (shouldn't happen given an 8-player max and 6 board
  locations, but not explicitly validated)
- Whether a 3rd occupant could ever land in one zone (not needed at 8 players max with this
  distribution, but worth a rule if the player cap ever changes)
