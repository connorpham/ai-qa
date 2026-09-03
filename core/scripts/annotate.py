#!/usr/bin/env python3
"""annotate.py — draw the box, write the caption.

A screenshot is not evidence until someone can tell, without asking you, which
pixels carried the verdict and what they prove. A red rectangle with no words
explains nothing; a full-page capture with no rectangle makes the reader hunt.
Both are the normal output of a hurried verification, which is why this is a
gated requirement rather than a suggestion.

    python3 .ai-qa/scripts/annotate.py box \\
      --img evd/SHOP-142/TC_1/03_total.png --rect 420,180,260,44 \\
      --label "TC_1: total recalculated to 450,000 (spec 3.2)" \\
      --out evd/SHOP-142/TC_1/03_total_boxed.png

    python3 .ai-qa/scripts/annotate.py diff \\
      --left design.png --right app.png --out design_vs_app.png \\
      --label "design (left) vs build (right) — button colour differs"

Prove it:  python3 annotate.py --selftest
Python 3.9 compatible. Needs Pillow.
"""
import argparse
import os
import sys

BOX = (220, 38, 38)          # a red that survives being printed in greyscale
CAPTION_BG = (17, 17, 17)
CAPTION_FG = (255, 255, 255)
PAD = 10
BORDER = 4


def need_pillow():
    try:
        from PIL import Image, ImageDraw, ImageFont  # noqa: F401
        return True
    except ImportError:
        print("ANNOTATE: BLOCKED — Pillow is not installed")
        print("  unblock: pip install pillow")
        print("  Do NOT submit an unannotated screenshot instead; the evidence gate")
        print("  will red it, and a reader could not use it anyway.")
        return False


def _font(size):
    from PIL import ImageFont
    # A real TrueType face if one is around, so the caption is legible at any
    # size; Pillow's bitmap default otherwise, which is small but never absent.
    for path in ("/System/Library/Fonts/Helvetica.ttc",
                 "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                 "C:\\Windows\\Fonts\\arialbd.ttf"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _text_size(draw, text, font):
    try:
        box = draw.textbbox((0, 0), text, font=font)
        return box[2] - box[0], box[3] - box[1]
    except AttributeError:  # very old Pillow
        return draw.textsize(text, font=font)


def _wrap(draw, text, font, max_width):
    words = str(text).split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if _text_size(draw, trial, font)[0] <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def caption_strip(img, label):
    """Put the caption INSIDE the image, on a bar under it.

    In-image rather than in a sidecar file, because evidence gets copied into
    tickets, chat and slide decks one file at a time, and a caption that lives
    somewhere else is a caption nobody reads.
    """
    from PIL import Image, ImageDraw
    if not label:
        return img
    draw = ImageDraw.Draw(img)
    size = max(14, min(26, img.width // 55))
    font = _font(size)
    lines = _wrap(draw, label, font, img.width - 2 * PAD)
    line_h = _text_size(draw, "Ag", font)[1] + 6
    strip_h = line_h * len(lines) + 2 * PAD

    out = Image.new("RGB", (img.width, img.height + strip_h), CAPTION_BG)
    out.paste(img.convert("RGB"), (0, 0))
    d = ImageDraw.Draw(out)
    y = img.height + PAD
    for line in lines:
        d.text((PAD, y), line, fill=CAPTION_FG, font=font)
        y += line_h
    return out


def cmd_box(args):
    from PIL import Image, ImageDraw
    if not os.path.exists(args.img):
        print("ANNOTATE: no such image: {}".format(args.img))
        return 1
    img = Image.open(args.img).convert("RGB")

    if args.rect:
        try:
            x, y, w, h = [int(p.strip()) for p in args.rect.split(",")]
        except ValueError:
            print("ANNOTATE: --rect must be X,Y,W,H in pixels (got {!r})".format(args.rect))
            return 1
        d = ImageDraw.Draw(img)
        for i in range(BORDER):
            d.rectangle([x - i, y - i, x + w + i, y + h + i], outline=BOX)
    elif not args.label:
        print("ANNOTATE: pass --rect, --label, or both — an untouched copy is not an annotation")
        return 1

    out = caption_strip(img, args.label)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out.save(args.out)
    print("ANNOTATE: OK  {}".format(args.out))
    return 0


def cmd_diff(args):
    from PIL import Image, ImageDraw
    for p in (args.left, args.right):
        if not os.path.exists(p):
            print("ANNOTATE: no such image: {}".format(p))
            return 1
    left = Image.open(args.left).convert("RGB")
    right = Image.open(args.right).convert("RGB")

    h = max(left.height, right.height)
    gap = 16
    canvas = Image.new("RGB", (left.width + right.width + gap, h), (245, 245, 245))
    canvas.paste(left, (0, 0))
    canvas.paste(right, (left.width + gap, 0))

    d = ImageDraw.Draw(canvas)
    font = _font(max(14, min(24, canvas.width // 70)))
    d.text((PAD, PAD), args.left_label, fill=BOX, font=font)
    d.text((left.width + gap + PAD, PAD), args.right_label, fill=BOX, font=font)

    out = caption_strip(canvas, args.label)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out.save(args.out)
    print("ANNOTATE: OK  {}".format(args.out))
    return 0


def selftest():
    import tempfile
    import shutil
    from PIL import Image

    tmp = tempfile.mkdtemp(prefix="aiqa-annotate-")
    fails = []
    try:
        src = os.path.join(tmp, "shot.png")
        Image.new("RGB", (400, 300), (255, 255, 255)).save(src)

        # box + caption must change the pixels AND grow the image
        out = os.path.join(tmp, "shot_boxed.png")
        rc = cmd_box(argparse.Namespace(img=src, rect="50,50,120,40",
                                        label="TC_1: total recalculated to 450,000", out=out))
        if rc != 0 or not os.path.exists(out):
            fails.append("box did not produce an output file")
        else:
            a, b = Image.open(src), Image.open(out)
            if b.height <= a.height:
                fails.append("caption strip did not grow the image — the caption is not in the file")
            if list(b.crop((0, 0, 400, 300)).getdata()) == list(a.getdata()):
                fails.append("the box was never drawn — pixels are unchanged")

        # an annotation with neither a box nor a caption must be refused
        rc = cmd_box(argparse.Namespace(img=src, rect=None, label=None,
                                        out=os.path.join(tmp, "noop.png")))
        if rc == 0:
            fails.append("an empty annotation was accepted — that is just a copy")

        # a malformed rect must be refused, not silently ignored
        rc = cmd_box(argparse.Namespace(img=src, rect="not,a,rect,x", label="x",
                                        out=os.path.join(tmp, "bad.png")))
        if rc == 0:
            fails.append("a malformed --rect was accepted")

        # diff must be wider than either input
        right = os.path.join(tmp, "app.png")
        Image.new("RGB", (400, 300), (240, 240, 255)).save(right)
        dout = os.path.join(tmp, "diff.png")
        cmd_diff(argparse.Namespace(left=src, right=right, out=dout, label="design vs build",
                                    left_label="design", right_label="build"))
        if not os.path.exists(dout) or Image.open(dout).width <= 400:
            fails.append("diff did not place the two images side by side")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if fails:
        print("annotate --selftest FAILED")
        for f in fails:
            print("  x {}".format(f))
        return 1
    print("annotate --selftest passed  (box drawn, caption embedded, empty and malformed input refused)")
    return 0


def main():
    ap = argparse.ArgumentParser(description="annotate evidence images")
    sub = ap.add_subparsers(dest="cmd")

    b = sub.add_parser("box", help="draw a box and burn in a caption")
    b.add_argument("--img", required=True)
    b.add_argument("--rect", help="X,Y,W,H in pixels")
    b.add_argument("--label", help="what this proves — a stranger reads THIS")
    b.add_argument("--out", required=True)

    d = sub.add_parser("diff", help="two images side by side, captioned")
    d.add_argument("--left", required=True)
    d.add_argument("--right", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--label")
    d.add_argument("--left-label", default="expected", dest="left_label")
    d.add_argument("--right-label", default="actual", dest="right_label")

    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest() if need_pillow() else 1
    if not args.cmd:
        ap.print_help()
        return 2
    if not need_pillow():
        return 1
    return cmd_box(args) if args.cmd == "box" else cmd_diff(args)


if __name__ == "__main__":
    sys.exit(main())
