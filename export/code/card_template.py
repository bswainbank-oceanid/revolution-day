import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

# ---------- canvas spec (The Game Crafter poker, full bleed) ----------
W, H = 825, 1125    # 2.75in x 3.75in @ 300dpi — matches TGC's actual template exactly
SAFE = 75           # 1/4in safe zone from true edge (text/icons must stay inside this)
CUT_LINE = 38       # 1/8in bleed margin — this is the TRUE physical cut line (reference only)
TRIM = 60            # where our visible border actually draws — well inside CUT_LINE, so the
                     # bleed area between the true edge and our border is pure background color
CONTENT_EDGE = TRIM + 26   # margin for content bars (ribbon, dividers, boxes) — clears both
                            # border keylines so they never draw through content

FONTS = "/home/claude/fonts/"
F_TITLE = FONTS + "Oswald-Bold.ttf"
F_SEMI  = FONTS + "Oswald-SemiBold.ttf"
F_MED   = FONTS + "Oswald-Medium.ttf"
F_REG   = FONTS + "Oswald-Regular.ttf"

INK = (21, 21, 9)
CREAM = (238, 227, 199)
GOLD = (196, 155, 61)
BORDER_WHITE = (240, 238, 230)

REGIME = {
    "base_dark":  (58, 10, 10),
    "base_mid":   (122, 24, 22),
    "base_light": (205, 75, 55),
    "accent":     (238, 227, 199),
    "name": "REGIME",
}
REBEL = {
    "base_dark":  (12, 22, 14),
    "base_mid":   (28, 42, 26),
    "base_light": (95, 135, 75),
    "accent":     (238, 227, 199),
    "name": "REBEL",
}

def font(path, size):
    return ImageFont.truetype(path, size)

def vgrad(draw, box, c_top, c_bot):
    x0,y0,x1,y1 = box
    h = int(y1-y0)
    for i in range(h):
        t = i/max(h-1,1)
        r = int(c_top[0]*(1-t)+c_bot[0]*t)
        g = int(c_top[1]*(1-t)+c_bot[1]*t)
        b = int(c_top[2]*(1-t)+c_bot[2]*t)
        draw.line([(x0,y0+i),(x1,y0+i)], fill=(r,g,b))

def text_tracked(draw, xy, s, fnt, fill, tracking=0, anchor_right=None, anchor_center=None):
    widths = [draw.textlength(ch, font=fnt) for ch in s]
    total = sum(widths) + tracking*(len(s)-1)
    x0,y0 = xy
    if anchor_right is not None:
        x0 = anchor_right - total
    elif anchor_center is not None:
        x0 = anchor_center - total/2
    x = x0
    for ch,w in zip(s,widths):
        draw.text((x,y0), ch, font=fnt, fill=fill)
        x += w + tracking
    return total

def text_width(draw, s, fnt, tracking=0):
    widths = [draw.textlength(ch, font=fnt) for ch in s]
    return sum(widths) + tracking*(len(s)-1)

def vcenter_y(draw, s, fnt, box_top, box_h):
    bbox = draw.textbbox((0,0), s, font=fnt)
    text_h = bbox[3]-bbox[1]
    return box_top + (box_h-text_h)/2 - bbox[1]

def wrap_text_indent(draw, s, fnt, first_max_width, rest_max_width):
    """Like wrap_text, but the first line can have a different (usually narrower)
       max width than subsequent lines — needed when the first line starts after
       a label prefix like 'ACTIVATE: '."""
    words = s.split(" ")
    lines, cur = [], ""
    max_w = first_max_width
    for w in words:
        trial = (cur+" "+w).strip()
        if draw.textlength(trial, font=fnt) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
            max_w = rest_max_width
    if cur: lines.append(cur)
    return lines

def wrap_text(draw, s, fnt, max_width):
    words = s.split(" ")
    lines, cur = [], ""
    for w in words:
        trial = (cur+" "+w).strip()
        if draw.textlength(trial, font=fnt) <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

# ---------------- Icons ----------------
def icon_protected(draw, cx, cy, r, color, lw=4):
    pts = [(cx-r, cy-r*0.7),(cx+r, cy-r*0.7),(cx+r, cy+r*0.15),
            (cx, cy+r*1.1),(cx-r, cy+r*0.15)]
    draw.polygon(pts, outline=color, width=lw)

def icon_blend(draw, cx, cy, r, color, lw=4):
    draw.ellipse([cx-r, cy-r*0.6, cx+r, cy+r*0.6], outline=color, width=lw)
    draw.ellipse([cx-r*0.28, cy-r*0.28, cx+r*0.28, cy+r*0.28], fill=color)

def icon_public_crowd(draw, cx, cy, r, color, lw=4):
    for dx in (-0.62, 0.0, 0.62):
        px = cx + dx*r
        py = cy + (0.12*r if dx==0 else 0.22*r)
        headr = r*0.20
        head_cy = py - r*0.62
        draw.ellipse([px-headr, head_cy-headr, px+headr, head_cy+headr], fill=color)
        bw = r*0.42
        body_top = head_cy + headr*0.6
        draw.polygon([(px-bw*0.55, py+r*0.38),(px+bw*0.55, py+r*0.38),
                      (px+bw*0.5, body_top),(px-bw*0.5, body_top)], fill=color)

def icon_street(draw, cx, cy, r, color, lw=4):
    draw.line([(cx-r*0.8, cy+r*0.8),(cx, cy-r*0.8)], fill=color, width=lw)
    draw.line([(cx, cy-r*0.8),(cx+r*0.8, cy+r*0.8)], fill=color, width=lw)
    draw.line([(cx, cy+r*0.15),(cx, cy+r*0.75)], fill=color, width=max(2,lw-2))

def icon_secure_bars(draw, cx, cy, r, color, lw=4):
    draw.rectangle([cx-r*0.95, cy-r*0.95, cx+r*0.95, cy+r*0.95], outline=color, width=max(3,int(r*0.14)))
    for dx in (-0.55,-0.18,0.18,0.55):
        draw.rectangle([cx+dx*r-r*0.06, cy-r*0.85, cx+dx*r+r*0.06, cy+r*0.85], fill=color)

LOC_ICONS = {"Public": icon_public_crowd, "Street": icon_street, "Secure": icon_secure_bars}

def icon_activate(draw, cx, cy, r, color, lw=0):
    pts = [(cx+r*0.15,cy-r),(cx-r*0.5,cy+r*0.15),(cx-r*0.05,cy+r*0.15),
           (cx-r*0.15,cy+r),(cx+r*0.5,cy-r*0.1),(cx+r*0.05,cy-r*0.1)]
    draw.polygon(pts, fill=color)

def icon_response(draw, cx, cy, r, color, lw=4):
    draw.arc([cx-r, cy-r, cx+r, cy+r], 30, 300, fill=color, width=lw)
    ax_,ay_ = cx+r*math.cos(math.radians(30)), cy+r*math.sin(math.radians(30))
    draw.polygon([(ax_-r*0.32,ay_-r*0.05),(ax_+r*0.12,ay_-r*0.35),(ax_+r*0.05,ay_+r*0.28)], fill=color)

def icon_alarm(draw, cx, cy, r, color, lw=3):
    # warning triangle with a bold exclamation mark
    draw.polygon([(cx,cy-r*1.05),(cx+r*1.05,cy+r*0.85),(cx-r*1.05,cy+r*0.85)], outline=color, width=lw)
    draw.rectangle([cx-r*0.08, cy-r*0.45, cx+r*0.08, cy+r*0.15], fill=color)
    draw.ellipse([cx-r*0.10, cy+r*0.30, cx+r*0.10, cy+r*0.50], fill=color)

# ---------------- Alignment icons ----------------
def icon_star(draw, cx, cy, r, color):
    pts = []
    for i in range(10):
        ang = -math.pi/2 + i*math.pi/5
        rad = r if i%2==0 else r*0.42
        pts.append((cx+rad*math.cos(ang), cy+rad*math.sin(ang)))
    draw.polygon(pts, fill=color)

def icon_regime_tower(draw, cx, cy, r, color, lw=4):
    body_w = r*1.1
    draw.rectangle([cx-body_w*0.5, cy-r*0.15, cx+body_w*0.5, cy+r*1.05], fill=color)
    n = 3
    cren_w = body_w/(2*n-1)
    for i in range(n):
        x0 = cx-body_w*0.5 + i*2*cren_w
        draw.rectangle([x0, cy-r*0.55, x0+cren_w, cy-r*0.15], fill=color)
    draw.polygon([(cx-body_w*0.5-r*0.12, cy+r*1.05),(cx+body_w*0.5+r*0.12, cy+r*1.05),
                  (cx+body_w*0.5, cy+r*0.8),(cx-body_w*0.5, cy+r*0.8)], fill=color)

def icon_regime(draw, cx, cy, r, color, lw=4):
    icon_regime_tower(draw, cx, cy - r*0.25, r, color, lw=lw)

_GUN_EMBLEM_PATH = "/home/claude/cards/assets/crossed_pistols.png"
_gun_emblem_cache = {}
def _load_gun_emblem():
    if "im" not in _gun_emblem_cache:
        _gun_emblem_cache["im"] = Image.open(_GUN_EMBLEM_PATH).convert("RGBA")
    return _gun_emblem_cache["im"]

def icon_rebel(draw, cx, cy, r, color, lw=0):
    base_img = draw._image
    emblem = _load_gun_emblem()
    alpha = emblem.split()[3]
    solid = Image.new("RGBA", emblem.size, tuple(color) + (255,))
    solid.putalpha(alpha)
    size = int(r*2.5)
    resized = solid.resize((size,size), Image.LANCZOS)
    base_img.paste(resized, (int(cx-size/2), int(cy-size/2)), resized)

def icon_regime_leader(draw, cx, cy, r, color, lw=4):
    icon_regime_tower(draw, cx, cy - r*0.25, r, color, lw=lw)
    icon_star(draw, cx, cy-r*1.55, r*0.32, color)

def icon_rebel_leader(draw, cx, cy, r, color, lw=4):
    icon_rebel(draw, cx, cy, r, color)
    icon_star(draw, cx, cy-r*1.55, r*0.32, color)

def _rotate_pts(pts, ang):
    ca, sa = math.cos(ang), math.sin(ang)
    return [(x*ca - y*sa, x*sa + y*ca) for x,y in pts]

def _leaf_shape(length, width):
    return [(0,-length),(width,0),(0,length),(-width,0)]

def icon_laurel(draw, cx, cy, ring_r, color):
    n = 9
    for side in (-1,1):
        for i in range(n):
            frac = i/(n-1)
            ang_deg = 90 - side*(8 + frac*160)   # near-full coverage, small gap at the very top
            ang = math.radians(ang_deg)
            leaf_len = ring_r*0.30*(1-frac*0.45)
            leaf_w = leaf_len*0.4
            pos_r = ring_r*1.16
            lx = cx+math.cos(ang)*pos_r
            ly = cy+math.sin(ang)*pos_r
            local = _leaf_shape(leaf_len, leaf_w)
            rotated = _rotate_pts(local, ang-math.pi/2)
            poly = [(lx+px, ly+py) for px,py in rotated]
            draw.polygon(poly, fill=color)

def icon_presidential(draw, cx, cy, r, color, lw=4):
    # a fancier "seal" treatment: laurel-flanked medallion ring encircling the tower + star
    ring_cy = cy - r*0.25
    ring_r = r*1.55
    icon_laurel(draw, cx, ring_cy, ring_r, color)
    draw.ellipse([cx-ring_r, ring_cy-ring_r, cx+ring_r, ring_cy+ring_r], outline=color, width=max(2,int(lw*0.7)))
    icon_regime_tower(draw, cx, cy - r*0.65, r, color, lw=lw)
    icon_star(draw, cx, cy-r*1.55, r*0.32, color)

ALIGNMENT_ICONS = {
    "regime": icon_regime,
    "rebel": icon_rebel,
    "regime_leader": icon_regime_leader,
    "rebel_leader": icon_rebel_leader,
}

# ---------------- Portrait handling ----------------
def cover_resize(im, target_w, target_h):
    sw, sh = im.size
    scale = max(target_w/sw, target_h/sh)
    nw, nh = int(sw*scale+0.5), int(sh*scale+0.5)
    im2 = im.resize((nw,nh), Image.LANCZOS)
    x0 = (nw-target_w)//2
    y0 = (nh-target_h)//2
    return im2.crop((x0,y0,x0+target_w,y0+target_h))

def contain_pillarbox(im, target_w, target_h, bar_color):
    sw, sh = im.size
    scale = min(target_w/sw, target_h/sh)
    nw, nh = int(sw*scale+0.5), int(sh*scale+0.5)
    im2 = im.resize((nw,nh), Image.LANCZOS)
    canvas = Image.new("RGB", (target_w, target_h), bar_color)
    canvas.paste(im2, ((target_w-nw)//2, (target_h-nh)//2))
    return canvas

def duotone(im, dark, light):
    gray = ImageOps.grayscale(im)
    gray = ImageOps.autocontrast(gray, cutoff=1)
    return ImageOps.colorize(gray, black=dark, white=light)

def shade_portrait(im, pal, mode="c1"):
    return duotone(im, pal["base_dark"], CREAM)

PORTRAIT_DIR = "/home/claude/chars_extracted/portraits/"
def load_portrait(slug):
    path = PORTRAIT_DIR + slug + ".png"
    try:
        return Image.open(path).convert("RGB")
    except FileNotFoundError:
        return None

# ---------------- Border / corners ----------------
def _corner_diamond(d, cx, cy, s, color):
    d.polygon([(cx,cy-s),(cx+s,cy),(cx,cy+s),(cx-s,cy)], fill=color)

def _corner_pennant(d, cx, cy, s, sign_x, sign_y, color):
    d.polygon([(cx, cy), (cx+sign_x*s*1.6, cy), (cx, cy+sign_y*s*1.6)], fill=color)

def draw_corner_ornaments(d, faction, is_leader, color):
    s = 26 if is_leader else 22   # +60% from previous (16/14 -> 25.6/22.4, rounded)
    corners = [(TRIM,TRIM,1,1), (W-TRIM,TRIM,-1,1), (TRIM,H-TRIM,1,-1), (W-TRIM,H-TRIM,-1,-1)]
    for cx,cy,sx,sy in corners:
        if faction == "REGIME":
            _corner_diamond(d, cx, cy, s, color)
        else:
            _corner_pennant(d, cx, cy, s, sx, sy, color)

def draw_card_background(img, pal):
    d = ImageDraw.Draw(img)
    d.rectangle([0,0,W,H], fill=pal["base_dark"])
    noise = Image.effect_noise((W,H), 22).convert("L")
    grain = Image.merge("RGB",(noise,noise,noise))
    blended = Image.blend(img.convert("RGB"), grain, 0.035)
    img.paste(blended,(0,0))
    return ImageDraw.Draw(img)

def draw_card_border(d, pal, is_leader):
    trim_color = GOLD if is_leader else BORDER_WHITE
    trim_w = 10 if is_leader else 6
    d.rectangle([TRIM,TRIM,W-TRIM,H-TRIM], outline=trim_color, width=trim_w)
    d.rectangle([TRIM+10,TRIM+10,W-TRIM-10,H-TRIM-10], outline=trim_color, width=2)
    if is_leader:
        d.rectangle([TRIM+18,TRIM+18,W-TRIM-18,H-TRIM-18], outline=trim_color, width=2)
    draw_corner_ornaments(d, pal["name"], is_leader, trim_color)

# ---------------- Main card renderer ----------------
def draw_card(data, faction, is_leader=False, is_president=False, portrait_slug=None):
    pal = REGIME if faction=="Regime" else REBEL
    border_color = GOLD if is_leader else BORDER_WHITE
    img = Image.new("RGB",(W,H), pal["base_dark"])
    d = draw_card_background(img, pal)

    pad = SAFE
    portrait = load_portrait(portrait_slug) if portrait_slug else None
    y = max(TRIM + 26, SAFE + 2)   # clears the leader inner keyline AND respects the true safe zone

    top_frame_budget = int(H * 0.58)
    vgrad(d, (TRIM+4, TRIM+4, W-TRIM-4, top_frame_budget), pal["base_mid"], pal["base_dark"])

    # --- faction ribbon ---
    ribbon_h = 30
    d.rectangle([CONTENT_EDGE, y, W-CONTENT_EDGE, y+ribbon_h], fill=INK)
    label = ("LEADER — " if is_leader else "") + pal["name"] if not is_president else "PRESIDENT"
    lf = font(F_SEMI,18)
    text_tracked(d,(0,vcenter_y(d,label,lf,y,ribbon_h)), label, lf, CREAM, tracking=3, anchor_center=W/2)
    y += ribbon_h + 12

    # --- title + alignment icon, side by side, centered as one unit ---
    title_text = data["name"].upper()
    def _title_fit(size):
        nf_try = font(F_TITLE, size)
        tw = text_width(d, title_text, nf_try, tracking=1)
        base_h = size+16
        ar_reg = base_h*0.42
        ar = ar_reg*1.35 if is_leader else ar_reg
        return ar*2+14+tw, tw

    max_allowed_combo_w = W - 190
    name_font_size = 44
    combo_check, title_w = _title_fit(44)
    if combo_check > max_allowed_combo_w:
        name_font_size = 34
        combo_check, title_w = _title_fit(34)
    nf = font(F_TITLE, name_font_size)
    base_title_band_h = name_font_size + 16

    align_key = ("regime_leader" if faction=="Regime" else "rebel_leader") if is_leader else \
                ("regime" if faction=="Regime" else "rebel")
    align_color = GOLD if is_leader else CREAM
    align_r_regular = base_title_band_h*0.42
    align_r = align_r_regular*1.35 if is_leader else align_r_regular   # leaders get a visibly bigger icon

    if is_leader:
        icon_above = 1.87*align_r   # star top, measured from icon center
        icon_below = 0.80*align_r   # tower/emblem bottom, measured from icon center
        pad_v = 8              # gives real clearance from the icon-ribbon divider below
        title_band_h = int(icon_above + icon_below + pad_v*2)
        top_pad_actual = 2     # bumped up further — icon/title sit closer to the ribbon
        icon_cy = y + top_pad_actual + icon_above
    else:
        title_band_h = base_title_band_h
        icon_cy = y + title_band_h/2

    gap = 14
    combo_w = align_r*2 + gap + title_w
    icon_cx = W/2 - combo_w/2 + align_r
    text_x0 = icon_cx + align_r + gap
    text_box_top = icon_cy - base_title_band_h/2

    ALIGNMENT_ICONS[align_key](d, icon_cx, icon_cy, align_r, align_color, lw=3)
    text_tracked(d,(text_x0, vcenter_y(d,title_text,nf,text_box_top,base_title_band_h)), title_text, nf, CREAM, tracking=1)
    y += title_band_h

    # --- portrait, centered between icon ribbon and card border ---
    row_w = W - CONTENT_EDGE - (TRIM+4)
    icon_ribbon_w = int(row_w * 0.20)

    art_top = y
    icon_col_x0 = CONTENT_EDGE
    icon_col_x1 = icon_col_x0 + icon_ribbon_w
    zone_right = W - TRIM - 4
    avail_w = zone_right - icon_col_x1

    band_h = top_frame_budget - art_top
    vmargin = 24
    sq = band_h - 2*vmargin
    sq = min(sq, int(avail_w*0.94))
    hmargin = (avail_w - sq)//2

    sq_left = icon_col_x1 + hmargin
    sq_right = sq_left + sq
    port_top = art_top + int((band_h - sq)*0.32)   # biased toward the top instead of perfectly centered

    if portrait:
        art = contain_pillarbox(portrait, sq, sq, pal["base_mid"])
        art = shade_portrait(art, pal)
        img.paste(art, (sq_left, port_top))
    else:
        vgrad(d, (sq_left, port_top, sq_right, port_top+sq), pal["base_mid"], pal["base_dark"])
    d = ImageDraw.Draw(img)
    d.rectangle([sq_left, port_top, sq_right, port_top+sq], outline=border_color, width=4)
    d.line([(icon_col_x1, art_top),(icon_col_x1, art_top+band_h)], fill=border_color, width=2)

    # --- icon ribbon: DEPLOY LOCATIONS, then ATTRIBUTES ---
    col_cx = (icon_col_x0+icon_col_x1)/2
    locs = data.get("locations", [])
    attrs = data.get("attributes", [])

    label_zone_h = 48
    label2_zone_h = 40
    remaining = band_h - label_zone_h - label2_zone_h
    loc_zone_h = int(remaining * 3/5)
    attr_zone_h = remaining - loc_zone_h
    loc_bottom_pad = 16   # keeps the 3rd location icon from crowding the divider below it
    attr_bottom_pad = 16  # keeps the last attribute icon from crowding the bottom edge

    # size icons to guarantee they fit their slot without colliding with neighbors
    loc_slot = (loc_zone_h-loc_bottom_pad)/3
    attr_slot = (attr_zone_h-attr_bottom_pad)/2
    icon_r = min(loc_slot, attr_slot)/2 - 6
    icon_r = max(12, min(22, icon_r))

    label_font = font(F_SEMI, 13)

    # DEPLOY LOCATIONS
    lbl_y0 = art_top + 6
    text_tracked(d,(0,lbl_y0), "DEPLOY", label_font, GOLD, tracking=1, anchor_center=col_cx)
    text_tracked(d,(0,lbl_y0+16), "LOCATIONS", label_font, GOLD, tracking=1, anchor_center=col_cx)

    loc_zone_top = art_top + label_zone_h
    order = ["Secure","Public","Street"]
    gap_v = (loc_zone_h-loc_bottom_pad)/len(order)
    for i,loc_name in enumerate(order):
        cy_i = loc_zone_top + gap_v*i + gap_v/2
        active = loc_name in locs
        color = CREAM if active else tuple((pal["base_light"][k]//2+pal["base_dark"][k]//2) for k in range(3))
        if active:
            d.ellipse([col_cx-icon_r-6,cy_i-icon_r-6,col_cx+icon_r+6,cy_i+icon_r+6], outline=CREAM, width=2)
        LOC_ICONS[loc_name](d, col_cx, cy_i, icon_r*0.65, color, lw=3)

    # divider
    div_y = art_top + label_zone_h + loc_zone_h
    d.line([(icon_col_x0+10, div_y),(icon_col_x1-10, div_y)], fill=border_color, width=2)

    # ATTRIBUTES
    lbl2_y0 = div_y + 6
    text_tracked(d,(0,lbl2_y0), "ATTRIBUTES", label_font, GOLD, tracking=0, anchor_center=col_cx)

    attr_zone_top = div_y + label2_zone_h
    attr_order = [("Protected", icon_protected), ("Blend", icon_blend)]
    gap_v2 = (attr_zone_h-attr_bottom_pad)/len(attr_order)
    for i,(aname, afn) in enumerate(attr_order):
        cy_i = attr_zone_top + gap_v2*i + gap_v2/2
        active = aname in attrs
        color = CREAM if active else tuple((pal["base_light"][k]//2+pal["base_dark"][k]//2) for k in range(3))
        if active:
            d.ellipse([col_cx-icon_r-6,cy_i-icon_r-6,col_cx+icon_r+6,cy_i+icon_r+6], outline=CREAM, width=2)
        afn(d, col_cx, cy_i, icon_r*0.65, color, lw=3)

    y = art_top + band_h + 16

    # --- divider before ability text ---
    d.line([(CONTENT_EDGE,y),(W-CONTENT_EDGE,y)], fill=border_color, width=2)
    y += 14

    body_w = W - 2*pad
    ability_pad_x = 16
    apad = pad + ability_pad_x
    abody_w = W - 2*apad
    bf = font(F_REG, 23)
    bf_label = font(F_SEMI, 21)
    bf_italic = font(F_MED, 21)

    # --- Win Conditions: gradient-body box with a filled gold banner header ---
    if is_leader and "win_conditions" in data:
        wc_lines = data["win_conditions"]
        wrapped_all = []
        for line in wc_lines:
            wrapped_all.extend(wrap_text(d, line, bf, body_w-40))
        banner_h = 34
        top_pad = 20
        line_h = 30
        bottom_pad = 26
        box_h = banner_h + top_pad + len(wrapped_all)*line_h + bottom_pad
        x0, y0, x1, y1 = CONTENT_EDGE, y, W-CONTENT_EDGE, y+box_h
        vgrad(d, (x0, y0+banner_h, x1, y1), pal["base_mid"], pal["base_dark"])
        d.rectangle([x0, y0, x1, y0+banner_h], fill=GOLD)
        d.rectangle([x0, y0, x1, y1], outline=GOLD, width=3)
        text_tracked(d,(0,y0+8), "WIN CONDITIONS", font(F_SEMI,17), pal["base_dark"], tracking=2, anchor_center=W/2)
        yy = y0+banner_h+top_pad
        for wl in wrapped_all:
            text_tracked(d,(0,yy), wl, bf, CREAM, tracking=0, anchor_center=W/2)
            yy += line_h
        y += box_h + 14

    def draw_text_with_inline_alarm(x, yy, text, fnt, color, icon_r=13):
        if "[ALARM]" not in text:
            d.text((x,yy), text, font=fnt, fill=color)
            return x + d.textlength(text, font=fnt)
        parts = text.split("[ALARM]")
        cursor = x
        for i, part in enumerate(parts):
            if part:
                d.text((cursor,yy), part, font=fnt, fill=color)
                cursor += d.textlength(part, font=fnt)
            if i < len(parts)-1:
                icon_cy = yy + fnt.size*0.55
                icon_alarm(d, cursor+icon_r+4, icon_cy, icon_r, color)
                cursor += icon_r*2+8
        return cursor

    def draw_ability_block(ab_type, lines, y):
        icon_fn = {"Activate": icon_activate, "Response": icon_response}.get(ab_type)
        icon_r2 = 16
        has_alarm = len(lines)>0 and lines[0].strip().startswith("[ALARM]")
        display_lines = list(lines)
        if has_alarm:
            display_lines[0] = display_lines[0].replace("[ALARM]","").strip()

        if icon_fn:
            icon_fn(d, apad+icon_r2, y+icon_r2, icon_r2*0.75, CREAM, lw=3)
        if has_alarm:
            icon_alarm(d, apad+icon_r2*2+22, y+icon_r2, icon_r2*1.05, CREAM)

        label_x = apad+icon_r2*2+10 + (34 if has_alarm else 0)
        text_tracked(d,(label_x, y), ab_type.upper()+":", bf_label, GOLD, tracking=0)
        title_w2 = d.textlength(ab_type.upper()+": ", font=bf_label)
        first = True
        yy = y
        rest_max_w = abody_w-(label_x-apad)
        if has_alarm:
            rest_max_w -= 58   # reserve room for the trailing alarm icon after the last line
        last_line_end_x, last_line_y = label_x, y
        for line in display_lines:
            first_max_w = rest_max_w - title_w2 if first else rest_max_w
            wrapped = wrap_text_indent(d, line, bf, first_max_w, rest_max_w)
            for wi,wl in enumerate(wrapped):
                xs = label_x+title_w2 if (first and wi==0) else label_x
                end_x = draw_text_with_inline_alarm(xs, yy, wl, bf, CREAM)
                last_line_end_x = end_x
                last_line_y = yy
                yy += 28
            first = False
        if has_alarm:
            icon_alarm(d, last_line_end_x+18, last_line_y+icon_r2, icon_r2*1.05, CREAM)
        return yy+20

    def draw_passive_block(lines, y):
        wrapped_all = []
        for line in lines:
            wrapped_all.extend(wrap_text(d, line, bf_italic, abody_w))
        for wl in wrapped_all:
            text_tracked(d,(apad,y), wl, bf_italic, (210,200,175), tracking=0)
            y += 27
        return y+20

    for ab_type, lines in data.get("abilities", []):
        if ab_type == "Passive":
            y = draw_passive_block(lines, y)
        else:
            y = draw_ability_block(ab_type, lines, y)

    if data.get("flavor"):
        yy = H - pad - 60
        wrapped = wrap_text(d, data["flavor"], font(F_MED,20), body_w)
        for wl in wrapped:
            text_tracked(d,(0,yy), wl, font(F_MED,20), (210,196,160), tracking=0, anchor_center=W/2)
            yy += 24

    draw_card_border(d, pal, is_leader)
    return img

# ================= President (special card) =================
def draw_president_card(portrait_slug="president"):
    pal = REGIME
    img = Image.new("RGB",(W,H), pal["base_dark"])
    d = draw_card_background(img, pal)

    top_frame_budget = int(H * 0.72)
    vgrad(d, (TRIM+4, TRIM+4, W-TRIM-4, top_frame_budget), pal["base_mid"], pal["base_dark"])

    y = max(TRIM + 26, SAFE + 2)

    # --- ribbon ---
    ribbon_h = 30
    d.rectangle([CONTENT_EDGE, y, W-CONTENT_EDGE, y+ribbon_h], fill=INK)
    lf = font(F_SEMI, 18)
    text_tracked(d,(0,vcenter_y(d,"REGIME PRESIDENT",lf,y,ribbon_h)), "REGIME PRESIDENT", lf, CREAM, tracking=3, anchor_center=W/2)
    y += ribbon_h + 12

    # --- title + presidential seal icon (bigger than a regular leader's) ---
    name_font_size = 58
    nf = font(F_TITLE, name_font_size)
    base_title_band_h = name_font_size + 16
    title_text = "PRESIDENT"
    title_w = text_width(d, title_text, nf, tracking=1)

    align_r = base_title_band_h*0.42*0.93   # shrunk 40% from the previous 1.55x
    icon_above = 2.27*align_r    # measured from the actual rendered icon (star tip)
    icon_below = 2.00*align_r    # measured from the actual rendered icon (lowest wreath leaves)
    icon_half_w = 2.17*align_r   # measured from the actual rendered icon (widest wreath leaves)
    pad_v = 10
    title_band_h = int(icon_above+icon_below+pad_v*2)
    top_pad_actual = 3
    icon_cy = y + top_pad_actual + icon_above

    gap = 32
    combo_w = icon_half_w*2 + gap + title_w
    icon_cx = W/2 - combo_w/2 + icon_half_w
    text_x0 = icon_cx + icon_half_w + gap

    icon_presidential(d, icon_cx, icon_cy, align_r, GOLD, lw=4)
    text_tracked(d,(text_x0, vcenter_y(d,title_text,nf,icon_cy-base_title_band_h/2,base_title_band_h)), title_text, nf, CREAM, tracking=1)
    y += title_band_h

    # --- portrait: large, centered, no icon-ribbon column to share with ---
    portrait = load_portrait(portrait_slug)
    art_top = y
    band_h = top_frame_budget - art_top
    margin_x = CONTENT_EDGE
    avail_w = W - 2*margin_x
    sq = min(band_h - 20, avail_w)
    sq_left = W/2 - sq/2
    sq_right = W/2 + sq/2
    port_top = art_top + (band_h-sq)//2

    if portrait:
        art = contain_pillarbox(portrait, sq, sq, pal["base_mid"])
        art = shade_portrait(art, pal)
        img.paste(art, (int(sq_left), int(port_top)))
    d = ImageDraw.Draw(img)
    d.rectangle([sq_left, port_top, sq_right, port_top+sq], outline=GOLD, width=4)

    y = art_top + band_h + 16
    d.line([(CONTENT_EDGE,y),(W-CONTENT_EDGE,y)], fill=GOLD, width=2)
    y += 30

    # --- bottom: centered Protected icon + label (shrunk 30%), no other ability text ---
    remaining_h = (H-SAFE) - y
    icon_r_big = 42   # 60 * 0.7
    icon_cy2 = y + remaining_h*0.32
    icon_protected(d, W/2, icon_cy2, icon_r_big, GOLD, lw=5)
    label_y = icon_cy2 + icon_r_big*1.35
    text_tracked(d,(0,label_y), "PROTECTED", font(F_SEMI,18), GOLD, tracking=4, anchor_center=W/2)

    draw_card_border(d, pal, is_leader=True)
    return img

# ================= Motorcade (special card) =================
def draw_motorcade_card(text_lines, portrait_slug="motorcade"):
    pal = REGIME
    img = Image.new("RGB",(W,H), pal["base_dark"])
    d = draw_card_background(img, pal)

    top_frame_budget = int(H * 0.55)
    vgrad(d, (TRIM+4, TRIM+4, W-TRIM-4, top_frame_budget), pal["base_mid"], pal["base_dark"])

    y = SAFE + 6

    # --- title only, no ribbon, no faction icon ---
    name_font_size = 52
    nf = font(F_TITLE, name_font_size)
    title_band_h = name_font_size + 20
    text_tracked(d,(0,vcenter_y(d,"MOTORCADE",nf,y,title_band_h)), "MOTORCADE", nf, CREAM, tracking=2, anchor_center=W/2)
    y += title_band_h + 10

    # --- portrait: smaller and centered, no icon-ribbon column ---
    portrait = load_portrait(portrait_slug)
    art_top = y
    band_h = top_frame_budget - art_top
    sq = min(band_h - 20, int(W*0.55))
    sq_left = W/2 - sq/2
    sq_right = W/2 + sq/2
    port_top = art_top + (band_h-sq)//2

    if portrait:
        art = contain_pillarbox(portrait, sq, sq, pal["base_mid"])
        art = shade_portrait(art, pal)
        img.paste(art, (int(sq_left), int(port_top)))
    d = ImageDraw.Draw(img)
    d.rectangle([sq_left, port_top, sq_right, port_top+sq], outline=BORDER_WHITE, width=4)

    y = art_top + band_h + 16
    d.line([(CONTENT_EDGE,y),(W-CONTENT_EDGE,y)], fill=BORDER_WHITE, width=2)
    y += 30

    # --- bottom: rule text, centered — first use larger, gap + line break before the second ---
    bf_primary = font(F_REG, 34)
    bf_secondary = font(F_REG, 24)
    max_w = W-2*CONTENT_EDGE-20

    blocks = []  # (wrapped_lines, font, line_height)
    for i, line in enumerate(text_lines):
        fnt = bf_primary if i==0 else bf_secondary
        lh = 40 if i==0 else 30
        wrapped = wrap_text(d, line, fnt, max_w)
        blocks.append((wrapped, fnt, lh))

    block_gap = 26
    total_h = sum(len(w)*lh for w,f,lh in blocks) + block_gap*(len(blocks)-1)
    remaining_h = (H-SAFE) - y
    yy = y + (remaining_h-total_h)*0.35
    for bi,(wrapped, fnt, lh) in enumerate(blocks):
        for wl in wrapped:
            text_tracked(d,(0,yy), wl, fnt, CREAM, tracking=0, anchor_center=W/2)
            yy += lh
        if bi < len(blocks)-1:
            yy += block_gap

    draw_card_border(d, pal, is_leader=False)
    return img

# ================= Sample data =================
bodyguard = {
    "name":"Bodyguard", "locations":["Public","Street","Secure"], "attributes":[],
    "abilities":[("Response",["Eliminate a rebel target."]),
                 ("Passive",["If the President moves from this location, move this card to the same location."])],
}
gunman = {
    "name":"Gunman", "locations":["Street"], "attributes":["Blend"],
    "abilities":[("Activate",["[ALARM] Eliminate a target."]),
                 ("Response",["Eliminate a regime target."])],
}
head_of_security = {
    "name":"Head of Security", "locations":["Public","Street","Secure"], "attributes":["Protected"],
    "win_conditions":["President not eliminated.","Survive."],
    "abilities":[("Activate",["Activate any non-leader regime card, controlled by any player, at any location."]),
                 ("Response",["Eliminate a target."])],
}

if __name__ == "__main__":
    card1 = draw_card(bodyguard, "Regime", portrait_slug="bodyguard")
    card2 = draw_card(gunman, "Rebel", portrait_slug="gunman")
    card3 = draw_card(head_of_security, "Regime", is_leader=True, portrait_slug="head_of_security")
    card1.save("/home/claude/cards/sample_regime_bodyguard.png")
    card2.save("/home/claude/cards/sample_rebel_gunman.png")
    card3.save("/home/claude/cards/sample_leader_headofsecurity.png")
    print("done")
