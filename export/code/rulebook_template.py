import sys, math
sys.path.insert(0, "/home/claude/cards")
sys.path.insert(0, "/home/claude/boards")
import card_template as ct
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

# ---------- TGC Large Booklet spec (measured from uploaded template) ----------
W, H = 1575, 2475          # 5.25in x 8.25in @ 300dpi (full bleed)
CUT_LINE = 38               # 1/8in bleed margin (reference)
SAFE = 75                   # 1/4in safe zone from true edge

GOLD = ct.GOLD
CREAM = ct.CREAM
INK = ct.INK
REGIME = ct.REGIME
REBEL = ct.REBEL

# neutral dark blend used for the card back / cover — belongs to neither faction
COVER_DARK = tuple((REGIME["base_dark"][i]+REBEL["base_dark"][i])//2 for i in range(3))
COVER_MID = tuple((REGIME["base_mid"][i]+REBEL["base_mid"][i])//2 for i in range(3))

# lighter interior palette for body-text pages
PAGE_BG = (250, 247, 238)      # warm off-white, easy to read
PAGE_INK = (35, 30, 24)        # near-black body text
PAGE_ACCENT = (150, 32, 28)    # muted brick-red, echoes Regime without being loud
PAGE_RULE = (196, 155, 61)     # GOLD, for section rules/dividers

F_TITLE = ct.F_TITLE
F_SEMI = ct.F_SEMI
F_MED = ct.F_MED
F_REG = ct.F_REG

def font(path, size):
    return ct.font(path, size)

PAD = SAFE + 15
BODY_W = W - 2*PAD

def new_page():
    img = Image.new("RGB", (W,H), PAGE_BG)
    return img, ImageDraw.Draw(img)

def draw_header(d, page_num):
    y = PAD
    mark_cx, mark_cy, mark_r = PAD+18, y+18, 16
    d.ellipse([mark_cx-mark_r,mark_cy-mark_r,mark_cx+mark_r,mark_cy+mark_r], outline=PAGE_RULE, width=3)
    d.line([(mark_cx-mark_r-6,mark_cy),(mark_cx+mark_r+6,mark_cy)], fill=PAGE_RULE, width=3)
    d.line([(mark_cx,mark_cy-mark_r-6),(mark_cx,mark_cy+mark_r+6)], fill=PAGE_RULE, width=3)
    pf = font(F_SEMI, 20)
    ct.text_tracked(d,(0,y+6), f'PAGE {page_num}', pf, PAGE_ACCENT, tracking=2, anchor_right=W-PAD)
    y += 70
    d.line([(PAD,y),(W-PAD,y)], fill=PAGE_RULE, width=3)
    y += 45
    return y

def draw_top_headline(d, y, text, with_rule_above=False):
    if with_rule_above:
        d.line([(PAD,y),(W-PAD,y)], fill=PAGE_RULE, width=2)
        y += 35
    title_f = font(F_TITLE, 56)
    ct.text_tracked(d,(PAD,y), text, title_f, PAGE_INK, tracking=1)
    y += 90 if with_rule_above else 100
    return y

def draw_subheading(d, y, text):
    head_f = font(F_SEMI, 34)
    ct.text_tracked(d,(PAD,y), text, head_f, PAGE_ACCENT, tracking=2)
    y += 60
    return y

def draw_subheading_with_icon(d, y, text, icon_fn, icon_r=20):
    head_f = font(F_SEMI, 34)
    icon_cx = PAD + icon_r
    icon_cy = y + 24
    icon_fn(d, icon_cx, icon_cy, icon_r, PAGE_ACCENT, lw=3)
    ct.text_tracked(d,(PAD+icon_r*2+18,y), text, head_f, PAGE_ACCENT, tracking=2)
    y += 60
    return y

def draw_body(d, y, text, lh=48):
    body_f = font(F_REG, 30)
    wrapped = ct.wrap_text(d, text, body_f, BODY_W)
    for wl in wrapped:
        d.text((PAD,y), wl, font=body_f, fill=PAGE_INK)
        y += lh
    return y

def draw_bullets(d, y, items, lh=48, indent=42):
    body_f = font(F_REG, 30)
    for step in items:
        wrapped = ct.wrap_text(d, step, body_f, BODY_W-indent)
        d.ellipse([PAD+6,y+14,PAD+16,y+24], fill=PAGE_ACCENT)
        for wl in wrapped:
            d.text((PAD+indent,y), wl, font=body_f, fill=PAGE_INK)
            y += lh
        y += 12
    return y

def draw_callout_box(d, y, lines, lh=40):
    body_f = font(F_MED, 26)
    box_pad = 24
    all_wrapped = []
    for line in lines:
        all_wrapped.extend(ct.wrap_text(d, line, body_f, BODY_W-2*box_pad))
    box_h = box_pad*2 + len(all_wrapped)*lh
    d.rectangle([PAD, y, W-PAD, y+box_h], outline=PAGE_RULE, width=2)
    yy = y+box_pad
    for wl in all_wrapped:
        d.text((PAD+box_pad, yy), wl, font=body_f, fill=PAGE_ACCENT)
        yy += lh
    return y+box_h

