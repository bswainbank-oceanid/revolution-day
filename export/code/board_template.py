import sys, math
import numpy as np
sys.path.insert(0, "/home/claude/cards")
import card_template as ct
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

# ---------- TGC Small Square Board spec (measured from uploaded template) ----------
W, H = 1275, 1275          # 4.25in x 4.25in @ 300dpi (full bleed)
CUT_LINE = 38               # 1/8in bleed margin (reference)
SAFE = 75                   # 1/4in safe zone from true edge
FRAME = 100                 # where our black inset frame sits (inside safe zone, NOT at cut edge)

# ---------- neutral green-grey palette (shared by all locations) ----------
PAL = {
    "base_dark":  (42, 51, 46),
    "base_mid":   (66, 79, 71),
    "base_light": (110, 128, 116),
    "accent":     (238, 227, 199),   # reuse CREAM
}
INK = (18, 22, 19)
GOLD = ct.GOLD
CREAM = ct.CREAM

# ---------- 6 player tick colors (chosen to stand out on green-grey, none black) ----------
PLAYER_COLORS = [
    (230, 57, 70),    # crimson red
    (69, 123, 230),   # cobalt blue
    (255, 149, 5),    # amber orange
    (244, 208, 63),   # lemon yellow
    (155, 89, 220),   # violet purple
    (38, 179, 160),   # teal
]

FONTS = ct.FONTS
F_TITLE = ct.F_TITLE
F_SEMI = ct.F_SEMI

def font(path, size):
    return ct.font(path, size)

def vgrad(d, box, c1, c2):
    ct.vgrad(d, box, c1, c2)

def draw_tile_background(pal):
    img = Image.new("RGB", (W,H), pal["base_dark"])
    d = ImageDraw.Draw(img)
    vgrad(d, (0,0,W,H), pal["base_mid"], pal["base_dark"])
    noise = Image.effect_noise((W,H), 20).convert("L")
    grain = Image.merge("RGB",(noise,noise,noise))
    img = Image.blend(img, grain, 0.03)
    return img

def draw_frame_and_ticks(img, pal):
    d = ImageDraw.Draw(img)
    # black inset frame — NOT at the cut edge, purely decorative, safely inside the safe zone
    d.rectangle([FRAME, FRAME, W-FRAME, H-FRAME], outline=INK, width=6)

    # 6 player tick marks, evenly spaced around the perimeter, running from just inside
    # the frame out through it and all the way to the true tile edge
    ticks = []
    n = len(PLAYER_COLORS)
    per_side = 2  # 2 ticks per side x 4 sides = 8 slots, we'll use 6 of them (skip 2 to keep it light)
    positions = []
    # define candidate positions along each side (as fraction of side length), avoiding corners
    fracs = [0.30, 0.70]
    for frac in fracs:
        positions.append(("top", frac))
        positions.append(("bottom", frac))
    positions.append(("left", 0.5))
    positions.append(("right", 0.5))
    # use first 6
    positions = positions[:6]

    tick_len_in = FRAME + 30      # extends from tile edge inward past the frame a bit
    for (side, frac), color in zip(positions, PLAYER_COLORS):
        if side in ("top","bottom"):
            x = W*frac
            if side == "top":
                y0, y1 = 0, tick_len_in
            else:
                y0, y1 = H, H-tick_len_in
            d.line([(x,y0),(x,y1)], fill=color, width=10)
        else:
            y = H*frac
            if side == "left":
                x0, x1 = 0, tick_len_in
            else:
                x0, x1 = W, W-tick_len_in
            d.line([(x0,y),(x1,y)], fill=color, width=10)
    return d

def draw_badge(d, name, icon_fn, x1=None, y0=None):
    # icon + name badge, upper right corner — icon+text centered together as one unit
    badge_w, badge_h = 300, 92
    if x1 is None: x1 = W - 170
    if y0 is None: y0 = 170
    x0 = x1 - badge_w
    y1 = y0 + badge_h
    d.rounded_rectangle([x0,y0,x1,y1], radius=14, fill=INK, outline=GOLD, width=3)

    nf = font(F_TITLE, 34)
    icon_r = 26
    gap = 14
    text_w = d.textlength(name, font=nf)
    combo_w = icon_r*2 + gap + text_w
    combo_x0 = (x0+x1)/2 - combo_w/2

    icon_cx = combo_x0 + icon_r
    icon_cy = (y0+y1)/2
    icon_fn(d, icon_cx, icon_cy, icon_r, GOLD, lw=3)

    text_x = combo_x0 + icon_r*2 + gap
    ty = ct.vcenter_y(d, name, nf, y0, badge_h)
    ct.text_tracked(d, (text_x, ty), name, nf, CREAM, tracking=1)

def darken(c, factor=0.78):
    return tuple(int(v*factor) for v in c)

def draw_triangle_marker(d, apex, base_center, base_half_w, direction_perp, color):
    bx, by = base_center
    px, py = direction_perp
    p1 = (bx+px*base_half_w, by+py*base_half_w)
    p2 = (bx-px*base_half_w, by-py*base_half_w)
    d.polygon([apex, p1, p2], fill=color)

def prep_photo(path, size):
    im = Image.open(path).convert("RGB")
    arr = np.array(im)
    is_white = (arr[:,:,0]>250)&(arr[:,:,1]>250)&(arr[:,:,2]>250)
    row_white_frac = is_white.mean(axis=1)
    col_white_frac = is_white.mean(axis=0)
    content_rows = np.where(row_white_frac<0.5)[0]
    content_cols = np.where(col_white_frac<0.5)[0]
    if len(content_rows) and len(content_cols):
        r0,r1 = content_rows.min(), content_rows.max()
        c0,c1 = content_cols.min(), content_cols.max()
        if (r1-r0) < im.height*0.98 or (c1-c0) < im.width*0.98:
            im = im.crop((c0,r0,c1,r1))
    w,h = im.size
    s = min(w,h)
    left = (w-s)//2
    top = (h-s)//2
    im = im.crop((left,top,left+s,top+s))
    return im.resize((size,size), Image.LANCZOS)

def color_grade_toward_palette(im, pal, strength=0.35):
    g = ImageEnhance.Contrast(im).enhance(1.35)
    g = ImageEnhance.Color(g).enhance(1.05)
    tinted = Image.new("RGB", im.size, pal["base_mid"])
    g = Image.blend(g, tinted, 0.18)
    return g

BORDER_W = 28
TRI_SIZE = 68

def draw_location_tile(photo_path, name, icon_fn):
    photo = prep_photo(photo_path, W)
    img = color_grade_toward_palette(photo, PAL)
    d = ImageDraw.Draw(img)
    # no border — sits entirely in the bleed zone and doesn't survive trim reliably

    colors = [darken(c) for c in PLAYER_COLORS]
    cut = CUT_LINE
    corner_axis_offset = (TRI_SIZE*1.4) / math.sqrt(2)

    # corner triangles: apex sits exactly on the cut line (survives trim regardless of drift)
    corners = [(cut,cut,1,1), (W-cut,cut,-1,1), (cut,H-cut,1,-1), (W-cut,H-cut,-1,-1)]
    for i,(cx,cy,sx,sy) in enumerate(corners):
        apex = (cx, cy)
        base_center = (cx+sx*corner_axis_offset, cy+sy*corner_axis_offset)
        perp = (-sy, sx)
        draw_triangle_marker(d, apex, base_center, TRI_SIZE*0.55, perp, colors[i])

    # top/bottom edge triangles: apex on the cut line
    top_apex = (W/2, cut)
    d.polygon([top_apex, (W/2-TRI_SIZE*0.55, cut+TRI_SIZE*1.4), (W/2+TRI_SIZE*0.55, cut+TRI_SIZE*1.4)], fill=colors[4])
    bot_apex = (W/2, H-cut)
    d.polygon([bot_apex, (W/2-TRI_SIZE*0.55, H-cut-TRI_SIZE*1.4), (W/2+TRI_SIZE*0.55, H-cut-TRI_SIZE*1.4)], fill=colors[5])

    draw_badge(d, name, icon_fn)  # uses the shifted-in default position
    return img
