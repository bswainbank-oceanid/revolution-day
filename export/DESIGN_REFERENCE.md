# Revolution Day — Design Reference
For porting into a computer game version. This covers the visual system and specs;
see `card_data.json` in this same folder for structured rules/card data.

## Premise
A hidden-role civil war card game. The day after rigging his own re-election, a president
travels across the capital while regime and rebel leaders secretly conspire against him
(or for him). 2-8 players (best 3-5), 30-60 minutes.

Tagline: "A game of revolution, conspiracy, and secret agendas by Ben Swainbank"

## Visual identity

### Palette
- **Regime**: base_dark (58,10,10), base_mid (122,24,22), base_light (205,75,55) — blood red
- **Rebel**: base_dark (12,22,14), base_mid (28,42,26), base_light (95,135,75) — near-black green
- **Shared**: INK (21,21,9), CREAM (238,227,199), GOLD (196,155,61), BORDER_WHITE (240,238,230)
- **Neutral (cover/box/card-back)**: 50/50 blend of Regime and Rebel base_dark/base_mid
- **Location tiles**: green-grey neutral — base_dark (42,51,46), base_mid (66,79,71), base_light (110,128,116)
- **Player marker colors** (6, used on location tiles): crimson (230,57,70), cobalt (69,123,230),
  amber (255,149,5), lemon (244,208,63), violet (155,89,220), teal (38,179,160)
- **Rulebook interior**: warm off-white background (250,247,238), near-black ink (35,30,24),
  brick-red accent (150,32,28), gold rule (196,155,61)

### Fonts (Oswald family — included in `fonts/`)
- Bold: titles/headlines
- SemiBold: labels, section headers
- Medium: passive text, secondary labels
- Regular: body/ability text

### Card design language
- Regime = red gradient, tower icon, diamond corner ornaments
- Rebel = green gradient, crossed-pistols icon (game-icons.net, CC BY 3.0), pennant corners
- Leaders: gold border + extra keyline, larger alignment icon with a star above
- President: unique "seal" icon — laurel wreath around the tower+star, larger than a leader's
- Regular (non-leader): white border, single keyline
- Icon language: Activate (bolt), Response (curved arrow), Alarm (warning triangle),
  Protected (shield), Blend (eye), Street (chevron), Public (3-person silhouette),
  Secure (barred window)
- Portraits: duotone shading (dark→cream), faction-tinted

### Location tiles
- No border (TGC's own guidance: a border at the trim line looks bad under any cutting drift)
- 6 triangular player markers, apex sitting exactly on the cut line so they always survive
  trim drift regardless of print variance
- Badge (icon + name) in upper right, centered as one unit
- Real aerial photos, graded toward the palette (punchy contrast, light tint, not full duotone)

## Print specs (for reference only — a digital version won't need these,
but they explain proportions/crops already baked into the art)
- Cards: 825×1125px (2.75"×3.75" @300dpi), TGC poker card size
- Location tiles: 1275×1275px (4.25"×4.25" @300dpi), TGC small square board
- Rulebook: 1575×2475px (5.25"×8.25" @300dpi), TGC large booklet, 8 pages
- Box: TGC "prototype/pizza box" style, one-sheet, two-tray (lid + base) fold pattern

## File inventory in this export
- `cards/` — all 48 card faces: 8 leaders, 22 regime, 17 rebel (with duplicates), President,
  9× Motorcade. Filenames indicate faction/type.
- `locations/` — 6 location tiles (3 Street variants, Arena, HQ, Palace) + a shared tile back
- `rulebook/` — all 8 final rulebook pages, in order
- `box_and_back/` — full box die-cut sheet, and the corrected 825×1125 card back
- `logos/` — Revolution Day logo (SVG + PNG) and the Mithril Mine publisher mark
- `code/` — the three Python/Pillow generation scripts (`card_template.py`,
  `board_template.py`, `rulebook_template.py`). Not meant to be reused as-is for a computer
  game, but they're the authoritative source for every color, font size, icon shape, and
  layout constant if you need to recreate something at a different resolution or in a
  different toolchain.
- `fonts/` — the 4 Oswald weights used throughout
- `card_data.json` — structured game data: every card/leader's faction, locations, attributes,
  and ability text, plus full rules (turn structure, alarms/responses, win/end conditions,
  additional rulings). This is the most directly useful file for implementing game logic.

## Known open items / things not yet finalized
- Character portraits are placeholder AI-generated art — real/licensed art credits will need
  to be added to the rulebook credits page once that's settled
- The 6 location tiles' source photos are licensed stock (attribution/license type wasn't
  tracked in this export — check before reusing outside the prototype)
