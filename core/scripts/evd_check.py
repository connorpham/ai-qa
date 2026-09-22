#!/usr/bin/env python3
"""evd_check.py — the evidence gate.

Asks one question of a finished verification: **could a stranger reconstruct
this verdict from the folder alone?** Every rule here exists because a real
verification went wrong without it, and every rule can go RED.

    python3 .ai-qa/scripts/evd_check.py --evd evd/SHOP-142 --expect-tcs 3

Exit 0 = green. Exit 1 = red, with every failure printed. Nothing is written.

Prove the gate itself:  python3 evd_check.py --selftest
The selftest builds a green fixture, asserts it passes, then mutates it one rule
at a time and asserts each mutation goes red. A gate that has never failed does
not exist.

Python 3.9 compatible.
"""
import argparse
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import shutil
import tempfile
import zlib

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "lib"))
sys.path.insert(0, _HERE)
try:
    import ctx  # type: ignore
except Exception:  # pragma: no cover - the gate must run without a config
    ctx = None
try:
    import evd_index  # type: ignore
except Exception:  # pragma: no cover - an older install may not have it
    evd_index = None

VERDICTS = ("PASS", "FAIL", "PARTIAL", "NEW-BUG", "BLOCKED", "UNCLEAR")
CASE_RESULTS = ("PASS", "FAIL", "BLOCKED")
KINDS = ("acceptance", "boundary", "whole-screen", "write-readback", "exploratory", "security")

# A finding is something the run SAW that this ticket did not ask about. The
# doctrine has always said "a finding outside this ticket's scope gets its own
# bug report" — and until now nothing checked the report was ever written, or
# that the evidence for it survived anywhere a reader could find it.
FINDING_DIR = re.compile(r"^F(\d+)(?:_([A-Za-z0-9][A-Za-z0-9_-]*))?$")
SEVERITIES = ("Blocker", "Critical", "Major", "Minor")
ORIGINS = ("DEV", "SPEC")

# A citation nobody can open is worse than no citation: it wears the uniform of
# evidence. Three shapes are legal here and no fourth — a document this project
# declared as its oracle, with the section inside it; the schema, for a data
# rule; or a named floor rule, the small set of outcomes (no 500, no data loss,
# no secret in a response) that are wrong whether or not anyone wrote them down.
#
# A bare section number is none of the three. "3.2" is a citation only to the
# person who already knows which file it lives in, and that person is never the
# one reading the report six weeks later.
CITE_FLOOR = re.compile(r"(?i)^floor\b[\s:]*(.*)$")
CITE_SEP = re.compile(r"[;\n]|\s+and\s+")
# A path token: it has a directory in it, or an extension on the end.
CITE_PATH = re.compile(r"^[^\s]*(?:/[^\s]*|\.[A-Za-z0-9]{1,9})$")

# Fields every case manifest must carry. The names are the discipline: a field
# you have to fill in is a question you cannot skip.
REQUIRED_FIELDS = ("RESULT", "AS", "PRECONDITION", "ENTRY", "STEPS", "EXPECTED", "ACTUAL")
UI_ONLY_FIELDS = ("AFTER", "BACK")

# An EXPECTED that is only a judgement word is a wish, not a value; an ACTUAL
# that is only a judgement word is a verdict with nothing behind it. Each phrase
# here has been the ENTIRE content of a real case record, and none of them lets
# a reader look at the screen and agree or disagree. Matched against the whole
# value, so "the total reads 450,000 and works offline" is never flagged.
_VAGUE_PHRASES = (
    "works", "work", "worked", "working", "not working", "not work", "works fine",
    "works correctly", "works properly", "works as expected", "works ok", "work fine",
    "work correctly", "work properly", "work as expected", "did not work", "does not work",
    "doesn't work", "passes", "passed", "pass", "ok", "okay", "fine", "good", "success",
    "successful", "successfully", "as expected", "correct", "correctly", "proper", "properly",
    "no error", "no errors", "no issue", "no issues", "no problem", "no problems",
    "behaves correctly", "behaves properly", "behaves as expected", "failed", "fail", "fails",
    "failure", "error", "broken", "wrong", "incorrect", "n/a", "tbd", "todo",
)
VAGUE_VALUE = re.compile(
    r"^\W*(?:it\s+|this\s+|the\s+(?:feature|page|screen|form|button)\s+)?(?:should\s+|must\s+)?"
    r"(?:be\s+|is\s+|was\s+)?(?:"
    + "|".join(re.escape(x).replace(r"\ ", r"\s+")
               for x in sorted(_VAGUE_PHRASES, key=len, reverse=True))
    + r")\W*$", re.I)

# A step image may carry its case number: TC3_02_total_after_save.png. The
# prefix is what keeps a file legible after someone drags it out of the folder
# and into a ticket, a chat or a slide, which is where evidence actually goes.
STEP_IMAGE = re.compile(r"^(?:TC(\d+)_)?(\d{2})_.+\.(png|jpg|jpeg)$", re.I)
BOXED_IMAGE = re.compile(r"_boxed\.(png|jpg|jpeg)$", re.I)
# TC_<n>_<what_it_proves>. The number orders the case; the words are what make
# `ls evd/SHOP-142` a test plan instead of a row of drawer handles.
CASE_DIR = re.compile(r"^TC_(\d+)(?:_([A-Za-z0-9][A-Za-z0-9_-]*))?$")


# An 8-byte file called `03_total_after_save_boxed.png` used to pass every rule
# in this gate. That is not a hypothetical: it is the fixture THIS FILE builds to
# prove itself, and it went green. Writing a plausible screenshot of an
# application you never opened is a far harder thing to do than writing a
# convincing paragraph about one, which is exactly why the gate should look at
# the pixels and not only at the prose around them.
MIN_IMAGE_W, MIN_IMAGE_H = 320, 240


def image_size(path):
    """(width, height) of a PNG or JPEG, or None if the bytes are not one.

    Stdlib only, header only — this runs on every image in every pack and must
    not depend on Pillow being installed or read a 4MB screenshot to learn two
    numbers.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(32)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                if len(head) < 24 or head[12:16] != b"IHDR":
                    return None
                return struct.unpack(">II", head[16:24])
            if head[:2] == b"\xff\xd8":
                fh.seek(2)
                while True:
                    marker = fh.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                        fh.read(3)
                        h, w = struct.unpack(">HH", fh.read(4))
                        return (w, h)
                    (length,) = struct.unpack(">H", fh.read(2))
                    fh.seek(length - 2, 1)
    except (OSError, struct.error):
        return None
    return None


def _sha(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def check_images(case_dir, where, images, res):
    """Look at the pixels.

    Three things a forged pack cannot survive and a real run always does: the
    file is an image, it is the size of a screen, and the pictures differ from
    each other. The third one catches the cheapest forgery of all — one
    screenshot copied under five step names.
    """
    seen = {}
    for name in images:
        full = os.path.join(case_dir, name)
        size = image_size(full)
        if size is None:
            res.err(where, "{} is not a PNG or JPEG — {} bytes of something else. A screenshot "
                           "nobody can open proves nothing, and a file named like one is the "
                           "cheapest possible forgery"
                    .format(name, os.path.getsize(full) if os.path.exists(full) else 0))
            continue
        w, h = size
        if w < MIN_IMAGE_W or h < MIN_IMAGE_H:
            res.err(where, "{} is {}x{} — too small to be a screen. Evidence is what the tester "
                           "saw, at the size they saw it".format(name, w, h))
            continue
        digest = _sha(full)
        if digest and digest in seen:
            res.err(where, "{} is byte-for-byte the same image as {} — one screenshot filed under "
                           "two step names is one step, whatever the names say"
                    .format(name, seen[digest]))
        elif digest:
            seen[digest] = name

    # The box is the point of a boxed image. If it is identical to the shot it
    # was drawn from, nothing was drawn.
    for name in images:
        if not BOXED_IMAGE.search(name):
            continue
        plain = BOXED_IMAGE.sub(lambda m: "." + m.group(1), name)
        if plain in images:
            a, b = _sha(os.path.join(case_dir, name)), _sha(os.path.join(case_dir, plain))
            if a and a == b:
                res.err(where, "{} is identical to {} — the overlay was never drawn, so the reader "
                               "still has to guess which pixels mattered".format(name, plain))


def _dirs_of(case_dir):
    """The case folder and its immediate subfolders. A case that makes several
    calls keeps one folder per call, and its evidence is no less real for
    sitting one level down."""
    out = [case_dir]
    try:
        for d in sorted(os.listdir(case_dir)):
            full = os.path.join(case_dir, d)
            if os.path.isdir(full):
                out.append(full)
    except OSError:
        pass
    return out


def _names(d):
    try:
        return set(os.listdir(d))
    except OSError:
        return set()


def verification_files(case_dir):
    """Recorded verifications this case holds, as paths relative to the case.

    Three shapes count, because these are the three the lane's own tools
    produce:

      * db_verify.md   — db_verify.py, a read-only query and its real output
      * cmd_verify.md  — a command and what came back, incl. api_check.mjs's own
      * request.http + response.json — api_check.mjs's recorded exchange

    The pair used NOT to count, so an API case built entirely out of what
    api_check.mjs writes still went red until somebody hand-wrote a third file.
    A gate asking for a file the toolchain does not produce teaches people that
    the gate is wrong rather than that the evidence is missing.
    """
    found = []
    for d in _dirs_of(case_dir):
        names = _names(d)
        for n in ("db_verify.md", "cmd_verify.md"):
            if n in names:
                found.append(os.path.relpath(os.path.join(d, n), case_dir))
        if "request.http" in names and "response.json" in names:
            found.append(os.path.relpath(os.path.join(d, "request.http"), case_dir))
    return found


def db_verify_files(case_dir):
    """Read-back evidence specifically — a recorded query against the database.
    A request/response pair does NOT count here: the interface reporting
    "saved" is a claim about the interface, not about the data."""
    return [os.path.relpath(os.path.join(d, "db_verify.md"), case_dir)
            for d in _dirs_of(case_dir) if "db_verify.md" in _names(d)]


class Result:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.notes = []

    def err(self, where, msg):
        self.errors.append("{}: {}".format(where, msg))

    def warn(self, where, msg):
        self.warnings.append("{}: {}".format(where, msg))

    @property
    def ok(self):
        return not self.errors


# ---------------------------------------------------------------------------
# One name, one meaning
#
# `manifest.md` used to mean two different things: the index of a whole ticket
# at the root, and the record of a single case inside a TC folder. Same name,
# different content, different reader — so "open the manifest" always needed a
# follow-up question, and half the time you opened the wrong one.
#
# They are now `index.md` and `case.md`. The old name is still read, with a
# warning, because every evidence folder written before this exists and is
# still evidence. Both names present at once IS an error: nobody can tell which
# one the verdict came from.
# ---------------------------------------------------------------------------
CASE_FILE, CASE_FILE_OLD = "case.md", "manifest.md"
INDEX_FILE, INDEX_FILE_OLD = "index.md", "manifest.md"


def resolve_doc(folder, new, old, res=None, where=""):
    """The path to read, preferring the new name. Returns (path, name) or
    (None, None) when neither is there."""
    p_new = os.path.join(folder, new)
    p_old = os.path.join(folder, old)
    has_new, has_old = os.path.exists(p_new), os.path.exists(p_old)
    if has_new and has_old and res is not None:
        res.err(where or folder, "both {} and {} are here — two records of the same thing, and "
                                 "nothing says which one the verdict came from. Delete the old one"
                                 .format(new, old))
    if has_new:
        return p_new, new
    if has_old:
        if res is not None:
            res.warn(where or folder, "{} is the old name for {} — still read, but rename it: the "
                                      "same word meant the ticket index and a single case"
                                      .format(old, new))
        return p_old, old
    return None, None


def read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except Exception:
        return ""


def fields(text):
    """Parse 'KEY: value' lines out of a case manifest, one entry per key."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(?:[-*]\s*)?([A-Z][A-Z_-]{1,20}):\s*(.*)$", line)
        if m:
            key = m.group(1).upper()
            if key not in out:
                out[key] = m.group(2).strip()
    return out


def cfg_get(dotted, default):
    if ctx is None:
        return default
    try:
        return ctx.get(ctx.load(), dotted, default)
    except Exception:
        return default


def _project_root():
    """The project a citation resolves against — or "" when there isn't one.

    Empty on purpose. `ctx.find_root()` falls back to the CURRENT directory
    when no config is found, and a root that is merely wherever you happened to
    be standing turns every citation into a lie about a file that exists
    somewhere else. Empty lets run() use the evidence's own location instead.
    """
    if ctx is None:
        return ""
    try:
        root = ctx.find_root()
    except Exception:
        return ""
    return root if os.path.exists(os.path.join(root, "aiqa.config.yaml")) else ""


def oracle_sources():
    """The documents this project has declared decide what 'correct' means.

    The schema and the API contract count: a data rule is cited from the model
    and a response shape from the contract, and neither belongs in oracle.specs.
    A design URL does not — you cannot open it from a gate, so it is not a
    document this can resolve.
    """
    out = []
    for dotted in ("oracle.specs", "api.contract", "database.schema"):
        v = cfg_get(dotted, None)
        if isinstance(v, list):
            out.extend(str(x) for x in v if str(x).strip())
        elif isinstance(v, str) and v.strip():
            out.append(v.strip())
    return [_norm(x) for x in out if "://" not in x]


def check_case(case_dir, res, opts):
    name = os.path.basename(case_dir)
    m = CASE_DIR.match(name)
    case_no = m.group(1) if m else ""
    if m and not m.group(2):
        res.err(name, "the folder is called {} and nothing else — name it TC_{}_<what_it_proves> "
                      "so the reader knows what was tested without opening a file"
                      .format(name, case_no))
    man_path, _which = resolve_doc(case_dir, CASE_FILE, CASE_FILE_OLD, res, name)
    if not man_path:
        res.err(name, "no case.md — a folder of images is not a verification")
        return None

    text = read(man_path)
    f = fields(text)
    kind = f.get("KIND", "").lower()
    non_ui = f.get("TYPE", "").upper() == "NON-UI"

    required = list(REQUIRED_FIELDS) + ([] if non_ui else list(UI_ONLY_FIELDS))
    for key in required:
        if key not in f or not f[key]:
            res.err(name, "case.md is missing {} — {}".format(key, _why(key)))

    # Present is not the same as written. "EXPECTED: works as expected" passes
    # the line above and tells the reader nothing — see case-writing.md.
    for key in ("EXPECTED", "ACTUAL"):
        value = f.get(key, "")
        if value and VAGUE_VALUE.match(value):
            res.err(name, "{} is {!r} — a judgement, not a value. Write what the screen shows: "
                          "the number, the label or the state, with its citation. If that cannot "
                          "be written, the expected behaviour is not yet known".format(key, value))
    title = f.get("TITLE", "")
    if title and (len(title.split()) < 3 or re.match(r"(?i)^\s*(?:tc|test|case|check|verify)\b", title)):
        res.warn(name, "TITLE {!r} names a topic, not a behaviour — write who does what and what "
                       "must happen, e.g. 'A quantity of 0 is refused'".format(title))

    result = f.get("RESULT", "").upper()
    if result and result not in CASE_RESULTS:
        res.err(name, "RESULT is {!r}; must be one of {}".format(result, "/".join(CASE_RESULTS)))

    # The citation, before the early return for BLOCKED: a case that ran made a
    # claim, and a claim with no source is this tester's opinion in a uniform.
    if opts.get("require_citation") and result and result != "BLOCKED":
        req = f.get("REQUIREMENT", "")
        if not req:
            res.err(name, "case.md has no REQUIREMENT: — a {} with nothing cited is an opinion. "
                          "Name the document and section the EXPECTED was read out of, or the "
                          "floor rule it rests on (REQUIREMENT: FLOOR <rule>)".format(result))
        else:
            check_citation(name, "REQUIREMENT", req, res, opts)

    if kind and kind not in KINDS:
        res.err(name, "KIND is {!r}; must be one of {}".format(kind, ", ".join(KINDS)))
    if not kind:
        res.warn(name, "no KIND: — the suite cannot tell whether the boundary case was ever designed")

    # A case that could not run says so and stops; the rest of the rules are
    # about evidence that only a real run can produce.
    if result == "BLOCKED":
        if not re.search(r"(?im)^\s*(?:[-*]\s*)?(BLOCKED_BY|REASON|UNBLOCK):", text):
            res.err(name, "RESULT: BLOCKED needs a REASON: and an UNBLOCK: line — a blocker with no way out is a shrug")
        return kind

    entry = f.get("ENTRY", "")
    if entry and opts["require_click_entry"] and not non_ui:
        looks_like_url_only = re.match(r"^\s*https?://\S+\s*$", entry) is not None
        if looks_like_url_only:
            res.err(name, "ENTRY is only a URL — a typed address hides a missing menu item, a "
                          "wrong permission and an unreachable row at once. Walk the click path.")

    after = f.get("AFTER", "")
    if after and opts["require_reload"] and not non_ui:
        if not re.search(r"reload|refresh|F5|survives", after, re.I):
            res.err(name, "AFTER does not mention a reload — a save that dies on refresh is not a save")

    images = sorted(os.listdir(case_dir)) if os.path.isdir(case_dir) else []
    step_shots = [i for i in images if STEP_IMAGE.match(i)]
    boxed = [i for i in images if BOXED_IMAGE.search(i)]
    if opts.get("open_images", True):
        check_images(case_dir, name, step_shots, res)

    # An image whose prefix names a DIFFERENT case is the copy-paste that turns
    # a report into fiction: the picture proves something, just not this.
    unlabelled = 0
    for i in step_shots:
        got = STEP_IMAGE.match(i).group(1)
        if got is None:
            unlabelled += 1
        elif case_no and got.lstrip("0") != case_no.lstrip("0"):
            res.err(name, "{} carries the case number TC{} but sits in {} — evidence from "
                          "another case, or a filename nobody updated".format(i, got, name))
    if unlabelled and case_no:
        res.warn(name, "{} image(s) named NN_<what>.png with no TC{} prefix — pulled into a "
                       "ticket they no longer say which case they came from"
                       .format(unlabelled, case_no))

    if non_ui:
        if not verification_files(case_dir):
            res.err(name, "TYPE: NON-UI needs a recorded verification — db_verify.md, cmd_verify.md, "
                          "or a request.http + response.json pair — here or in one of this case's "
                          "folders. No images and no recorded run is not verification")
    else:
        if not step_shots:
            res.err(name, "no step screenshots named NN_<what>.png — filenames are the first "
                          "thing a reader sees, and a folder of numbers makes them open every file")
        if opts["require_annotation"] and not boxed:
            res.err(name, "no *_boxed image — an unannotated screenshot makes the reader guess "
                          "which pixels carried the verdict")

        # A filename is not an annotation. `03_result_boxed.png` can be a bare
        # screenshot somebody renamed, and for a long time this gate accepted
        # exactly that: the rule was on the NAME, not on the picture.
        #
        # browser.mjs's shotAnnotated writes shots.json beside the images,
        # declaring for each one what it proves. That declaration is what makes
        # "the image explains itself" a thing a machine can check — and what a
        # reader of the FOLDER (not just the image) can read.
        if boxed and opts["require_annotation"]:
            declared = read_shots(case_dir)
            if declared is None:
                res.warn(name, "no shots.json beside the images — the boxes were drawn by hand, so "
                               "nothing here says what each one proves. Drive the run through "
                               "browser.mjs's shotAnnotated() and it is written for you.")
            else:
                for img in boxed:
                    d = declared.get(img)
                    if d is None:
                        res.err(name, "{} is not declared in shots.json — an image nobody said "
                                      "anything about is an image nobody can use".format(img))
                    elif not str(d.get("proves", "")).strip():
                        res.err(name, "{} declares no `proves` — one line saying what it shows is "
                                      "the whole difference between evidence and a screenshot".format(img))
                    elif d.get("annotated") is False:
                        res.err(name, "{}: the overlay failed to draw ({}) — the file is named "
                                      "_boxed but the picture is bare. An image that claims an "
                                      "annotation it does not carry is worse than no image"
                                      .format(img, d.get("overlayError", "reason not recorded")))
                    elif d.get("selectorFound") is False:
                        res.warn(name, "{}: the selector {!r} matched nothing, so the image is boxed on "
                                       "nothing and says so — honest, but it proves nothing yet"
                                       .format(img, d.get("selector", "")))

    if opts["require_db_verify"] and kind == "write-readback":
        if not db_verify_files(case_dir):
            res.err(name, "KIND: write-readback with no db_verify.md — the interface saying "
                          "'Saved' is a claim about the interface, not about the data")
    return kind


def read_shots(case_dir):
    """What each annotated image declares it proves, keyed by filename.

    Returns None when there is no sidecar at all — a hand-annotated folder,
    which is warned about rather than failed: the older `annotate.py box`
    path is still legitimate, it just cannot say what it drew.
    """
    path_ = os.path.join(case_dir, "shots.json")
    if not os.path.exists(path_):
        return None
    try:
        with open(path_, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
    except Exception:
        return {}
    if not isinstance(rows, list):
        return {}
    return {str(r.get("file", "")): r for r in rows if isinstance(r, dict)}


def _why(key):
    return {
        "RESULT": "a case with no verdict is a folder of pictures",
        "AS": "a verdict with no actor cannot be reproduced, and half of all UI defects are role-shaped",
        "PRECONDITION": "an id from the ticket may not exist any more; an empty list from stale data is not a defect",
        "ENTRY": "where the user starts and what they click to arrive",
        "STEPS": "numbered, in the order a person does them",
        "EXPECTED": "with its citation — this is the whole verification",
        "ACTUAL": "what actually happened",
        "AFTER": "what changed, including whether it survives a reload",
        "BACK": "Back and Cancel — where 'it works' usually stops working",
        "REQUIREMENT": "the document and section the EXPECTED was read out of",
    }.get(key, "required")


def _norm(p):
    return p.replace("\\", "/").strip().strip("/")


def _declared(path, sources):
    """Is this document one the project declared as a source of 'correct'?

    A source may be a file or a folder; citing `docs/specs/orders.md` against a
    declared `docs/specs` is the ordinary case, because a project declares the
    shelf, not every book on it.
    """
    p = _norm(path)
    return any(p == _norm(s) or p.startswith(_norm(s) + "/") for s in sources)


def check_citation(where, label, value, res, opts):
    """Every claim names where 'correct' is written down — and the name resolves.

    Checked in that order on purpose. A citation that names nothing is the
    common failure; a citation that names a file which does not exist is the
    dangerous one, because it survives review.
    """
    root, sources = opts.get("root") or ".", opts.get("sources") or []
    parts = [p.strip() for p in CITE_SEP.split(value) if p.strip()]
    if not parts:
        res.err(where, "{} is empty — name the document and section, or the floor rule".format(label))
        return
    for part in parts:
        floor = CITE_FLOOR.match(part)
        if floor:
            if not floor.group(1).strip():
                res.err(where, "{} says FLOOR and stops — name which floor rule this rests on, "
                               "e.g. 'FLOOR: no unhandled 500 on a valid request'".format(label))
            continue
        tok = part.split()[0].rstrip(",;") if part.split() else ""
        if not CITE_PATH.match(tok):
            res.err(where, "{} is {!r} — that is a section number, not a citation. Which document "
                           "is it in? Write the path first and the section after it: "
                           "'docs/specs/orders.md 3.2 R1'".format(label, part))
            continue
        if not os.path.exists(os.path.join(root, tok)):
            res.err(where, "{} cites {!r}, and there is no such file under {}. A citation nobody "
                           "can open is not evidence; it is the APPEARANCE of evidence, "
                           "which is worse"
                           .format(label, tok, os.path.abspath(root)))
            continue
        if sources and not _declared(tok, sources):
            res.err(where, "{} cites {!r}, which this project has not declared as an oracle. "
                           "Declared: {}. Either cite one of those, or add this document to "
                           "oracle.specs in aiqa.config.yaml — an oracle nobody agreed on in "
                           "advance is one picked after the result was known"
                           .format(label, tok, ", ".join(sources)))


def check_findings(evd, res, verdict):
    """Things the run saw that this ticket did not ask about.

    The verification of SHOP-142 is where a bug in SHOP-210's area gets noticed,
    and the screenshot proving it is captured during SHOP-142's run. Filing the
    bug and leaving its evidence unnamed inside another ticket's folder is how
    it is lost: six months later somebody opens evd/SHOP-210/ and finds nothing.

    So a finding gets a folder of its own, under the run that found it, and the
    bug it was filed as points back here. Pointing rather than copying, because
    the record of a run must stay exactly as that run left it.
    """
    root = os.path.join(evd, "findings")
    dirs = []
    if os.path.isdir(root):
        dirs = sorted(d for d in os.listdir(root)
                      if FINDING_DIR.match(d) and os.path.isdir(os.path.join(root, d)))

    if verdict == "NEW-BUG" and not dirs:
        res.err("findings/", "the verdict is NEW-BUG and there is no findings/ folder — the one "
                             "thing that says what was found has not been written down")

    for d in dirs:
        fdir = os.path.join(root, d)
        fpath = os.path.join(fdir, "finding.md")
        where = "findings/{}".format(d)
        if not os.path.exists(fpath):
            res.err(where, "no finding.md — a folder of images nobody described is not a finding")
            continue
        text = read(fpath)
        f = fields(text)

        sev = f.get("SEVERITY", "")
        if not sev:
            res.err(where, "no SEVERITY — how much this hurts decides when anyone looks at it "
                           "(docs/qa/method/severity.md)")
        elif sev.split()[0].capitalize() not in SEVERITIES:
            res.err(where, "SEVERITY is {!r}; must be one of {}".format(sev, ", ".join(SEVERITIES)))

        origin = f.get("ORIGIN", "").upper()
        if not origin:
            res.err(where, "no ORIGIN — DEV (the code diverges from the spec) or SPEC (the spec "
                           "itself is wrong or missing). A spec-origin finding sent to a developer "
                           "produces a fix that is still wrong")
        elif origin.split()[0] not in ORIGINS:
            res.err(where, "ORIGIN is {!r}; must be DEV or SPEC".format(origin))

        if not f.get("DEDUP", ""):
            res.err(where, "no DEDUP — say which known issue this is, or that it is in none. "
                           "Re-reporting a KI costs the team more than the report is worth")

        filed = f.get("FILED-AS", "")
        if not filed:
            res.err(where, "no FILED-AS — either the ticket it became, or `none — <why it is not "
                           "worth one>`. Silence here is how a finding evaporates")
        elif not re.match(r"^(none\b|[A-Za-z][A-Za-z0-9]*-\d+)", filed):
            res.err(where, "FILED-AS is {!r} — expected a ticket key, or `none — <reason>`".format(filed))

        # An assertion with no artefact behind it is the thing this whole
        # toolchain exists to refuse.
        try:
            files = os.listdir(fdir)
        except OSError:
            files = []
        proof = [x for x in files if STEP_IMAGE.match(x) or x in ("db_verify.md", "cmd_verify.md", "response.json")]
        if not proof:
            res.err(where, "nothing here but words — a finding needs the image, query or recorded "
                           "response that made you believe it")


def check_report(evd, res, opts):
    path = os.path.join(evd, "REPORT.md")
    if not os.path.exists(path):
        res.err("REPORT.md", "missing — the report is the deliverable; everything else is preparation")
        return ""
    text = read(path)

    head = text.splitlines()[0] if text.splitlines() else ""
    verdict = next((v for v in VERDICTS if v in head.upper()), "")
    if not verdict:
        res.err("REPORT.md", "the first line carries no verdict; one of {}".format("/".join(VERDICTS)))

    for key, why in (("COMMIT", "the verdict binds to the code it ran against"),
                     ("VERIFIED-AT", "on squash/rebase repos the commit dies with the branch; "
                                     "this timestamp is the fallback anchor"),
                     ("ENVIRONMENT", "which environment this verdict came from, as <name — url> — "
                                     "a bug found on staging is not evidence about production"),
                     ("ORACLE", "what 'correct' was compared against — write NONE if nothing was")):
        if not re.search(r"(?im)^\s*{}:\s*\S".format(key), text):
            res.err("REPORT.md", "no {}: line — {}".format(key, why))

    if verdict in ("FAIL", "NEW-BUG", "PARTIAL"):
        if not re.search(r"(?i)severity", text):
            res.err("REPORT.md", "a failing verdict with no Severity — see docs/qa/method/severity.md")
        if not re.search(r"(?i)origin", text):
            res.err("REPORT.md", "a failing verdict with no Origin (DEV or SPEC) — a spec-origin "
                                 "finding sent to a developer produces a fix that is still wrong")

    # A sha is the one field in the report that can be checked against something
    # outside the pack. An invented one is the signature of a verdict written
    # without a run — and it costs a subprocess to catch.
    m = re.search(r"(?im)^\s*COMMIT:\s*([0-9a-f]{7,40})\b", text)
    if m and opts.get("check_commit", True):
        sha = m.group(1)
        root = opts.get("root") or "."
        try:
            found = subprocess.run(["git", "-C", root, "cat-file", "-e", sha + "^{commit}"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=10).returncode == 0
            in_repo = subprocess.run(["git", "-C", root, "rev-parse", "--git-dir"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            found, in_repo = True, False   # no git here; the pack is not the liar
        # Only inside a repository. A pack copied somewhere else to be read is
        # still evidence, and reding it for its surroundings teaches nobody.
        if in_repo and not found:
            res.err("REPORT.md", "COMMIT: {} is not a commit in this repository. A verdict binds "
                                 "to the code it ran against; a sha that resolves to nothing binds "
                                 "to nothing".format(sha))

    # ORACLE: NONE used to be free. It is not: a PASS is a statement that the
    # product matches something, and NONE says there was nothing to match. The
    # honest verdict in that situation is BLOCKED, and saying so is the service.
    m = re.search(r"(?im)^\s*ORACLE:\s*(.+)$", text)
    oracle = m.group(1).strip() if m else ""
    if opts.get("require_citation") and oracle:
        if re.match(r"(?i)^none\b", oracle):
            if verdict in ("PASS", "PARTIAL"):
                res.err("REPORT.md", "ORACLE: NONE on a {} verdict — you cannot certify that the "
                                     "product matches the specification and in the same breath say "
                                     "there is no specification. Cite the document, or report "
                                     "BLOCKED (no oracle) and say what needs writing".format(verdict))
        else:
            check_citation("REPORT.md", "ORACLE", oracle, res, opts)

    # Jargon in the body is not fatal, but it is the most common reason a report
    # gets ignored by the person who most needed to read it.
    body = text.split("## Appendix")[0]
    jargon = [w for w in ("stack trace", "null pointer", "controller", "endpoint", "regex", "async")
              if re.search(r"\b{}\b".format(w), body, re.I)]
    if jargon:
        res.warn("REPORT.md", "technical vocabulary in the body ({}) — the bar is a non-programmer "
                              "reading it in two minutes; move it to the appendix".format(", ".join(jargon)))

    # The verdict decides whether a findings/ folder is owed.
    return verdict


# The two lenses a verifier skips in silence more than any other, and always for
# the same reason: nobody wrote them into the ticket, so nobody tested them, so
# the pack looks complete while a whole class of defect was never looked at. The
# gate cannot decide WHEN they apply — that is judgement — but it can refuse the
# silence: the pack must NAME the case that covered each, or waive it out loud
# with a reason. A waiver is a five-second, honest answer ("no UI in this
# change"); the silent skip is the failure this rule exists to make impossible.
REQUIRED_COVERAGE = ("security", "accessibility")
_WAIVER = re.compile(r"(?i)\b(n/?a|not applicable|out of scope|kh[oô]ng áp d[uụ]ng|khong ap dung)\b")


def check_coverage(evd, res, cases):
    """The root manifest must declare, for each risk lens the framework insists on
    a decision about, either the case that covered it or an out-loud waiver."""
    path, _which = resolve_doc(evd, INDEX_FILE, INDEX_FILE_OLD)
    if not path:
        path = os.path.join(evd, INDEX_FILE)
    if not os.path.exists(path):
        return  # its absence is already reported upstream
    text = read(path)

    if not re.search(r"(?im)^\s*#*\s*COVERAGE\s*:", text):
        res.err(INDEX_FILE, "no COVERAGE: block — the pack never says whether {} were in scope. "
                               "Silent omission is exactly how a lens gets skipped: name the case that "
                               "covered each, or waive it with a reason.".format(" and ".join(REQUIRED_COVERAGE)))
        return

    # Scope to the COVERAGE section: from the marker to the next heading or EOF,
    # so the word "security" elsewhere in the prose is not mistaken for a line.
    after = text.split(re.split(r"(?im)^\s*#*\s*COVERAGE\s*:", text, maxsplit=1)[0], 1)[-1]
    block = re.split(r"(?im)^\s*#{1,6}\s+\S", after, maxsplit=1)[0]

    present = {int(CASE_DIR.match(c).group(1).lstrip("0") or "0"): c for c in cases}
    for lens in REQUIRED_COVERAGE:
        m = re.search(r"(?im)^\s*[-*]?\s*{}\s*:\s*(.+?)\s*$".format(lens), block)
        if not m:
            res.err(INDEX_FILE, "COVERAGE names no line for '{}' — decide it: a case, or a waiver "
                                   "with a reason".format(lens))
            continue
        value = m.group(1)
        tc = re.search(r"\bTC[_-]?(\d+)\b", value, re.I)
        if tc:
            no = int(tc.group(1))
            if no not in present:
                res.err(INDEX_FILE, "COVERAGE says '{}: {}' but there is no such case folder — a "
                                       "citation to a case that does not exist".format(lens, value))
            continue
        if _WAIVER.search(value):
            reason = _WAIVER.sub("", value).strip(" -—:.,").strip()
            if len(reason) < 10:
                res.err(INDEX_FILE, "COVERAGE waives '{}' with no reason — a waiver with no reason "
                                       "is a silent skip wearing a label".format(lens))
            continue
        res.err(INDEX_FILE, "COVERAGE line for '{}' is neither a case (TC_n) nor a waiver "
                               "(n/a — reason): {!r}".format(lens, value))


def run(evd, expect_tcs, opts):
    res = Result()
    # Two levels up from evd/<TICKET> is the project, and citations resolve
    # against it. main() passes the root it found from the config, which is
    # better; this is the fallback that keeps the gate usable when someone runs
    # it by hand from somewhere else.
    opts = dict(opts, root=opts.get("root")
                or os.path.dirname(os.path.dirname(os.path.abspath(evd))))
    if not os.path.isdir(evd):
        res.err(evd, "no such evidence folder")
        return res

    if not resolve_doc(evd, INDEX_FILE, INDEX_FILE_OLD, res, INDEX_FILE)[0]:
        res.err(INDEX_FILE, "missing at the evidence root — the plain-language index of what was checked")

    cases = sorted((d for d in os.listdir(evd)
                    if CASE_DIR.match(d) and os.path.isdir(os.path.join(evd, d))),
                   key=lambda d: int(CASE_DIR.match(d).group(1)))
    if not cases:
        res.err(evd, "no TC_<n>_<what_it_proves> folders — nothing was verified")
        return res

    seen = {}
    for d in cases:
        no = CASE_DIR.match(d).group(1).lstrip("0") or "0"
        if no in seen:
            res.err(evd, "two folders claim case {}: {} and {} — the report cites 'TC_{}' and the "
                         "reader cannot tell which one it means".format(no, seen[no], d, no))
        seen[no] = d

    if expect_tcs is not None and len(cases) != expect_tcs:
        res.err(evd, "planned {} test cases, found {} — 'planned 5, ran 1' is exactly what this "
                     "gate exists to catch".format(expect_tcs, len(cases)))

    lo, hi = opts["min_tcs"], opts["max_tcs"]
    if len(cases) < lo:
        res.err(evd, "{} case(s); the minimum is {} — one case is a demo, not a verification".format(len(cases), lo))
    if len(cases) > hi:
        res.warn(evd, "{} cases exceeds the budget of {} — a large suite usually means the choice "
                      "was never made by risk".format(len(cases), hi))

    kinds = []
    for case in cases:
        k = check_case(os.path.join(evd, case), res, opts)
        if k:
            kinds.append(k)

    ran = [c for c in cases
           if fields(read(resolve_doc(os.path.join(evd, c), CASE_FILE, CASE_FILE_OLD)[0] or "")).get("RESULT", "").upper() != "BLOCKED"]
    if ran:
        if opts["require_boundary"] and "boundary" not in kinds:
            res.err(evd, "no case with KIND: boundary — the happy path passing tells you nothing "
                         "about the input that must behave the other way")
        if opts["require_whole_screen"] and "whole-screen" not in kinds:
            res.err(evd, "no case with KIND: whole-screen — fixes break neighbours, and the "
                         "neighbour is what users notice")

    # The index is only worth having if it cannot be out of date.
    if evd_index is not None and resolve_doc(evd, INDEX_FILE, INDEX_FILE_OLD)[0]:
        why = evd_index.stale(evd)
        if why:
            res.err(INDEX_FILE, "{} — the folder cannot introduce itself. Run: "
                                   "python3 .ai-qa/scripts/evd_index.py --evd {}".format(why, evd))

    # Only when a config was actually found. "Nothing declared" and "nobody
    # asked me to read a config" are different facts, and a gate that reds on
    # the second one is a gate people learn to ignore. The per-case citations
    # still hold either way — every claim names a document that opens.
    if opts.get("require_citation") and ran and opts.get("config_found") and not opts.get("sources"):
        res.err("aiqa.config.yaml", "no oracle is declared (oracle.specs is empty) and {} case(s) "
                                    "here still reached a verdict. List the documents that decide "
                                    "what 'correct' means — until one exists, every PASS in this "
                                    "pack is an opinion".format(len(ran)))

    verdict = check_report(evd, res, opts)
    check_findings(evd, res, verdict)
    check_coverage(evd, res, cases)

    for name, why in (("verifysheet.md", "where expected values are derived and cited"),
                      ("debate.md", "the challenger's card — a verdict nobody tried to break")):
        if not os.path.exists(os.path.join(evd, name)):
            res.err(name, "missing — {}".format(why))
    return res


def report(res, evd):
    if res.errors:
        print("EVIDENCE: RED  ({})".format(evd))
        for e in res.errors:
            print("  x {}".format(e))
    else:
        print("EVIDENCE: GREEN  ({})".format(evd))
    for w in res.warnings:
        print("  ! {}".format(w))
    return 0 if res.ok else 1


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------
GREEN_CASE = """RESULT: PASS
KIND: acceptance
AS: staff@demo (role STAFF)
PRECONDITION: order #4102 exists, state PENDING
ENTRY: signed in -> Orders -> filter Pending -> row #4102 -> Edit
STEPS: 1. change quantity 2 -> 3   2. press Save
REQUIREMENT: docs/specs/orders.md 3.2 R1
EXPECTED: total recalculates to 450,000 (spec 3.2)
ACTUAL: total shows 450,000, "Saved" message appears
AFTER: list row shows 3; value survives a reload
BACK: Back returns to Orders with the Pending filter intact
"""

BOUNDARY_CASE = GREEN_CASE.replace("KIND: acceptance", "KIND: boundary")
SCREEN_CASE = GREEN_CASE.replace("KIND: acceptance", "KIND: whole-screen")

GREEN_REPORT = """# SHOP-142 — PASS
COMMIT: abc1234
VERIFIED-AT: 2026-09-03T10:00:00Z
ENVIRONMENT: local — http://localhost:3000
ORACLE: docs/specs/orders.md 3.2

## 1. What was asked for
On the order screen, changing a quantity must recalculate the total.

## 4. Conclusion
The requirement is met.
"""


# The fixture names its cases the way the gate now insists real ones are named,
# so the selftest is also the worked example.
C1 = "TC_1_quantity_change_recalculates_the_total"
C2 = "TC_2_quantity_zero_is_refused"
C3 = "TC_3_the_orders_screen_is_intact"


def _png(path, w=360, h=270, tint=0):
    """A real PNG, cheap to write and honest to read.

    The fixture used to write eight bytes. That is how the forgery this gate now
    refuses got into the gate's own proof of itself.

    One row repeated: the selftest builds a few hundred of these, and a
    per-pixel loop turns a two-second suite into a two-minute one for a picture
    nobody looks at.
    """
    row = b"\x00" + bytes((x + tint) % 256 for x in range(w * 3))
    rows = row * h

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(rows, 1)))
        fh.write(chunk(b"IEND", b""))


def _rewrite_bytes(path, data):
    with open(path, "wb") as fh:
        fh.write(data)


def _mkcase(root, name, manifest, images=True):
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, CASE_FILE), "w", encoding="utf-8") as fh:
        fh.write(manifest)
    if images:
        pre = "TC{}_".format(CASE_DIR.match(name).group(1)) if CASE_DIR.match(name) else ""
        # Each one different, because the gate now refuses a pack where every
        # step is the same picture under a new name.
        for tint, fn in enumerate(("01_orders_list.png", "03_total_after_save.png",
                                   "03_total_after_save_boxed.png")):
            _png(os.path.join(d, pre + fn), tint=tint * 37)
        # An annotated image DECLARES what it proves. Without this the fixture
        # would only exercise the filename rule — which is the rule that turned
        # out not to be enough.
        with open(os.path.join(d, "shots.json"), "w", encoding="utf-8") as fh:
            json.dump([{"file": pre + "03_total_after_save_boxed.png",
                        "proves": "the total recalculated after Save",
                        "selector": "#total", "expected": "450,000", "actual": "450,000",
                        "cite": "spec 3.2", "verdict": "PASS", "selectorFound": True}], fh)
    return d


def _fake_project(tmp):
    """A project around the evidence, because citations resolve against one.

    `docs/specs/orders.md` is the declared oracle; `README.md` exists and is
    NOT declared, which is how the selftest can tell "the file is missing" from
    "the file is not an oracle" — two different lies, two different reds.
    """
    os.makedirs(os.path.join(tmp, "docs", "specs"), exist_ok=True)
    for rel, body in (("docs/specs/orders.md", "# Orders\n## 3.2 Totals\nR1 total = qty x price\n"),
                      ("README.md", "# demo\n")):
        with open(os.path.join(tmp, *rel.split("/")), "w", encoding="utf-8") as fh:
            fh.write(body)


def _green_fixture(root):
    os.makedirs(root, exist_ok=True)
    # A pack cites documents, so the fixture has to stand in a project that has
    # them. Two levels up from evd/<TICKET> is that project — the same arithmetic
    # the gate does when nobody hands it a root.
    _fake_project(os.path.dirname(os.path.dirname(os.path.abspath(root))))
    for n, t in ((INDEX_FILE, "# SHOP-142\nWhat was checked, in plain language.\n\n"
                  "COVERAGE:\n- security: n/a — read-only pricing display, no auth, session or "
                  "write path touched\n- accessibility: TC_3\n"),
                 ("REPORT.md", GREEN_REPORT),
                 ("verifysheet.md", "EXPECTED per spec 3.2\n"),
                 ("debate.md", "verifier card\nchallenger card\nresolution\n")):
        with open(os.path.join(root, n), "w", encoding="utf-8") as fh:
            fh.write(t)
    # A finding the run saw but this ticket did not ask about. The green
    # fixture carries one so the happy path is exercised, not only the reds.
    fdir = os.path.join(root, "findings", "F1_discount_rounds_down")
    os.makedirs(fdir, exist_ok=True)
    with open(os.path.join(fdir, "finding.md"), "w", encoding="utf-8") as fh:
        fh.write("SEVERITY: Major\nORIGIN: DEV\nDEDUP: not in known-issues\n"
                 "FILED-AS: SHOP-210\nWHAT: the discount rounds down on odd totals\n")
    _png(os.path.join(fdir, "01_rounding.png"), tint=131)

    _mkcase(root, C1, GREEN_CASE)
    _mkcase(root, C2, BOUNDARY_CASE)
    _mkcase(root, C3, SCREEN_CASE)
    if evd_index is not None:
        evd_index.write(root)
    return root


DEFAULT_OPTS = {
    "min_tcs": 2, "max_tcs": 5, "require_boundary": True, "require_whole_screen": True,
    "require_reload": True, "require_annotation": True, "require_db_verify": True,
    "require_click_entry": True, "require_citation": True,
    "sources": ["docs/specs"], "config_found": True,
    "open_images": True, "check_commit": True,
}


def selftest():
    tmp = tempfile.mkdtemp(prefix="aiqa-evd-")
    fails = []

    def expect(cond, msg):
        if not cond:
            fails.append(msg)

    def fresh(name):
        # Under evd/ so the gate's own "two levels up is the project" fallback
        # is what resolves the citations — the selftest runs the real rule.
        d = os.path.join(tmp, "evd", name)
        if os.path.exists(d):
            shutil.rmtree(d)
        return _green_fixture(d)

    # 1. the green fixture must pass — a gate that reds on correct work is noise
    base = fresh("green")
    expect(run(base, 3, DEFAULT_OPTS).ok, "the green fixture did not pass")
    expect(not run(base, 5, DEFAULT_OPTS).ok, "expect-tcs mismatch (planned 5, found 3) did not go red")

    # 2. every rule must be able to fail, one mutation at a time
    mutations = [
        ("missing REPORT.md", lambda d: os.remove(os.path.join(d, "REPORT.md"))),
        ("missing debate.md", lambda d: os.remove(os.path.join(d, "debate.md"))),
        ("missing the root index", lambda d: os.remove(os.path.join(d, INDEX_FILE))),
        ("no COMMIT line", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("COMMIT: abc1234\n", ""))),
        ("no ENVIRONMENT line", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("ENVIRONMENT: local — http://localhost:3000\n", ""))),
        ("no ORACLE line", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("ORACLE: docs/specs/orders.md 3.2\n", ""))),
        ("FAIL without severity", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("— PASS", "— FAIL"))),
        ("no boundary case", lambda d: _rewrite(d, C2 + "/case.md", lambda t: t.replace("KIND: boundary", "KIND: acceptance"))),
        ("no whole-screen case", lambda d: _rewrite(d, C3 + "/case.md", lambda t: t.replace("KIND: whole-screen", "KIND: acceptance"))),
        ("case missing AS", lambda d: _rewrite(d, C1 + "/case.md", lambda t: re.sub(r"(?m)^AS:.*\n", "", t))),
        ("case missing EXPECTED", lambda d: _rewrite(d, C1 + "/case.md", lambda t: re.sub(r"(?m)^EXPECTED:.*\n", "", t))),
        ("EXPECTED is a wish, not a value", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^EXPECTED:.*$", "EXPECTED: works as expected", t))),
        ("ACTUAL is a judgement, not a value", lambda d: _rewrite(d, C2 + "/case.md",
            lambda t: re.sub(r"(?m)^ACTUAL:.*$", "ACTUAL: failed", t))),
        ("case missing BACK", lambda d: _rewrite(d, C1 + "/case.md", lambda t: re.sub(r"(?m)^BACK:.*\n", "", t))),
        ("ENTRY is only a URL", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^ENTRY:.*$", "ENTRY: http://localhost:3000/orders/4102/edit", t))),
        ("AFTER never reloads", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^AFTER:.*$", "AFTER: the list row shows 3", t))),
        # A finding with no severity, no origin, no dedup, no ticket and no
        # artefact is an assertion. Each of those is now a red.
        ("finding with no SEVERITY", lambda d: _rewrite(d, os.path.join("findings", "F1_discount_rounds_down", "finding.md"),
            lambda t: re.sub(r"(?m)^SEVERITY:.*\n", "", t))),
        ("finding with an invented SEVERITY", lambda d: _rewrite(d, os.path.join("findings", "F1_discount_rounds_down", "finding.md"),
            lambda t: t.replace("SEVERITY: Major", "SEVERITY: Quite bad"))),
        ("finding with no ORIGIN", lambda d: _rewrite(d, os.path.join("findings", "F1_discount_rounds_down", "finding.md"),
            lambda t: re.sub(r"(?m)^ORIGIN:.*\n", "", t))),
        ("finding with an ORIGIN that is neither DEV nor SPEC", lambda d: _rewrite(d, os.path.join("findings", "F1_discount_rounds_down", "finding.md"),
            lambda t: t.replace("ORIGIN: DEV", "ORIGIN: QA"))),
        ("finding never deduped against known-issues", lambda d: _rewrite(d, os.path.join("findings", "F1_discount_rounds_down", "finding.md"),
            lambda t: re.sub(r"(?m)^DEDUP:.*\n", "", t))),
        ("finding nobody said whether they filed", lambda d: _rewrite(d, os.path.join("findings", "F1_discount_rounds_down", "finding.md"),
            lambda t: re.sub(r"(?m)^FILED-AS:.*\n", "", t))),
        ("finding with no evidence behind it", lambda d: os.remove(
            os.path.join(d, "findings", "F1_discount_rounds_down", "01_rounding.png"))),
        ("finding folder with no finding.md", lambda d: os.remove(
            os.path.join(d, "findings", "F1_discount_rounds_down", "finding.md"))),
        ("NEW-BUG verdict with no findings at all", lambda d: [
            _rewrite(d, "REPORT.md", lambda t: t.replace("— PASS", "— NEW-BUG")),
            shutil.rmtree(os.path.join(d, "findings"))]),
        # One name, one meaning. Two records of the same thing, and nothing
        # says which one the verdict came from.
        ("both case.md and manifest.md in one case", lambda d: _rewrite_to(
            os.path.join(d, C1, "manifest.md"), read(os.path.join(d, C1, CASE_FILE)))),
        ("both index.md and manifest.md at the root", lambda d: _rewrite_to(
            os.path.join(d, "manifest.md"), read(os.path.join(d, INDEX_FILE)))),
        ("no boxed image", lambda d: os.remove(os.path.join(d, C1, "TC1_03_total_after_save_boxed.png"))),
        # A filename is not an annotation. These two are the rules that stop a
        # renamed screenshot from passing as evidence.
        ("a boxed image nobody declared", lambda d: _rewrite(d, os.path.join(C1, "shots.json"),
            lambda t: t.replace("TC1_03_total_after_save_boxed.png", "something_else.png"))),
        ("a declared image that proves nothing", lambda d: _rewrite(d, os.path.join(C1, "shots.json"),
            lambda t: t.replace("the total recalculated after Save", "   "))),
        ("an image that admits it was never annotated", lambda d: _rewrite(d, os.path.join(C1, "shots.json"),
            lambda t: t.replace('"selectorFound": true', '"selectorFound": true, "annotated": false'))),
        ("no step screenshots", lambda d: [os.remove(os.path.join(d, C1, f))
                                           for f in os.listdir(os.path.join(d, C1)) if f.endswith(".png")]),
        ("bad RESULT value", lambda d: _rewrite(d, C1 + "/case.md", lambda t: t.replace("RESULT: PASS", "RESULT: OK"))),
        ("BLOCKED with no way out", lambda d: _rewrite(d, C1 + "/case.md", lambda t: t.replace("RESULT: PASS", "RESULT: BLOCKED"))),
        ("write-readback with no db_verify", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: t.replace("KIND: acceptance", "KIND: write-readback"))),
        ("non-UI with no verification file", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: t.replace("KIND: acceptance", "KIND: acceptance\nTYPE: NON-UI"))),
        ("only one case", lambda d: [shutil.rmtree(os.path.join(d, C2)), shutil.rmtree(os.path.join(d, C3))]),
        ("case folder with no name", lambda d: os.rename(os.path.join(d, C2), os.path.join(d, "TC_2"))),
        ("two folders claiming case 2", lambda d: shutil.copytree(os.path.join(d, C2),
            os.path.join(d, "TC_2_quantity_zero_is_rejected"))),
        ("an image from another case", lambda d: shutil.copyfile(
            os.path.join(d, C1, "TC1_01_orders_list.png"),
            os.path.join(d, C1, "TC9_01_orders_list.png"))),
        ("no COVERAGE block", lambda d: _rewrite(d, INDEX_FILE,
            lambda t: re.sub(r"(?is)\nCOVERAGE:.*$", "\n", t))),
        ("COVERAGE names no security line", lambda d: _rewrite(d, INDEX_FILE,
            lambda t: re.sub(r"(?im)^\s*-\s*security:.*\n", "", t))),
        ("COVERAGE waives a lens with no reason", lambda d: _rewrite(d, INDEX_FILE,
            lambda t: re.sub(r"(?im)^(\s*-\s*security:).*$", r"\1 n/a", t))),
        ("COVERAGE cites a case that does not exist", lambda d: _rewrite(d, INDEX_FILE,
            lambda t: t.replace("accessibility: TC_3", "accessibility: TC_9"))),
        # Citations. Each of these has been a real report: a claim with no
        # source, a source nobody can open, a source nobody agreed on.
        ("case with no REQUIREMENT", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^REQUIREMENT:.*\n", "", t))),
        ("REQUIREMENT is a section number with no document", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^REQUIREMENT:.*$", "REQUIREMENT: 3.2 R1", t))),
        ("REQUIREMENT cites a file that does not exist", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^REQUIREMENT:.*$", "REQUIREMENT: docs/specs/gone.md 3.2", t))),
        ("REQUIREMENT cites a document nobody declared an oracle", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^REQUIREMENT:.*$", "REQUIREMENT: README.md intro", t))),
        ("REQUIREMENT says FLOOR and names no rule", lambda d: _rewrite(d, C1 + "/case.md",
            lambda t: re.sub(r"(?m)^REQUIREMENT:.*$", "REQUIREMENT: FLOOR", t))),
        ("ORACLE: NONE under a PASS verdict", lambda d: _rewrite(d, "REPORT.md",
            lambda t: t.replace("ORACLE: docs/specs/orders.md 3.2", "ORACLE: NONE"))),
        ("ORACLE cites a file that does not exist", lambda d: _rewrite(d, "REPORT.md",
            lambda t: t.replace("ORACLE: docs/specs/orders.md 3.2", "ORACLE: docs/specs/gone.md 3.2"))),
        # The pixels. Every one of these passed every other rule in this gate
        # until the gate started opening the files.
        ("a screenshot that is not an image", lambda d: _rewrite_bytes(
            os.path.join(d, C1, "TC1_01_orders_list.png"), b"\x89PNG\r\n\x1a\n")),
        ("a screenshot too small to be a screen", lambda d: _png(
            os.path.join(d, C1, "TC1_01_orders_list.png"), 100, 80)),
        ("one screenshot filed under two step names", lambda d: shutil.copyfile(
            os.path.join(d, C1, "TC1_01_orders_list.png"),
            os.path.join(d, C1, "TC1_03_total_after_save.png"))),
        ("a boxed image with no box drawn on it", lambda d: shutil.copyfile(
            os.path.join(d, C1, "TC1_03_total_after_save.png"),
            os.path.join(d, C1, "TC1_03_total_after_save_boxed.png"))),
    ]
    for i, (label, mutate) in enumerate(mutations):
        d = fresh("mut{}".format(i))
        mutate(d)
        # Re-index first, so every mutation is caught by its OWN rule rather
        # than by the staleness check standing downstream of all of them.
        if evd_index is not None and os.path.exists(os.path.join(d, "manifest.md")):
            evd_index.write(d)
        expect(not run(d, None, DEFAULT_OPTS).ok, "mutation did NOT go red: {}".format(label))

    # 2b. the index itself: a case the manifest never mentions
    if evd_index is not None:
        d = fresh("stale")
        _mkcase(d, "TC_4_a_refund_returns_the_stock", GREEN_CASE)   # added, never re-indexed
        expect(not run(d, None, DEFAULT_OPTS).ok, "a case missing from the index did not go red")
        evd_index.write(d)
        expect(run(d, None, DEFAULT_OPTS).ok, "re-running the index generator did not clear the red")

    # 3. a legitimately blocked case, fully declared, must still pass
    d = fresh("blocked")
    _rewrite(d, C1 + "/case.md", lambda t: t.replace("RESULT: PASS", "RESULT: BLOCKED")
             + "REASON: no account has refund permission\nUNBLOCK: ops to grant refund role to qa@demo\n")
    if evd_index is not None:
        evd_index.write(d)
    _rewrite(d, C1 + "/case.md", lambda t: re.sub(r"(?m)^REQUIREMENT:.*\n", "", t))
    expect(run(d, None, DEFAULT_OPTS).ok, "a fully-declared BLOCKED case should not red the gate")

    # 3b. citations: the three legal shapes, and the one situation that has no
    #     shape at all. A rule with no way to say "nothing is written down"
    #     does not produce citations, it produces invented ones.
    d = fresh("floor")
    _rewrite(d, C1 + "/case.md", lambda t: re.sub(
        r"(?m)^REQUIREMENT:.*$", "REQUIREMENT: FLOOR no unhandled 500 on a valid request", t))
    expect(run(d, None, DEFAULT_OPTS).ok, "a named floor rule is a legal citation and must pass")

    d = fresh("oracle-none-blocked")
    _rewrite(d, "REPORT.md", lambda t: t.replace("— PASS", "— BLOCKED")
             .replace("ORACLE: docs/specs/orders.md 3.2", "ORACLE: NONE"))
    expect(run(d, None, DEFAULT_OPTS).ok,
           "ORACLE: NONE under a BLOCKED verdict is the honest answer and must pass")

    # 3c. the one field that can be checked against something outside the pack.
    #     An invented sha is the signature of a verdict written without a run.
    gitroot = os.path.join(tmp, "repo")
    os.makedirs(gitroot, exist_ok=True)
    quiet = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if subprocess.run(["git", "-C", gitroot, "init"], **quiet).returncode == 0:
        _fake_project(gitroot)
        subprocess.run(["git", "-C", gitroot, "add", "-A"], **quiet)
        subprocess.run(["git", "-C", gitroot, "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-m", "specs"], **quiet)
        real = subprocess.run(["git", "-C", gitroot, "rev-parse", "HEAD"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        sha = real.stdout.decode().strip()
        d = _green_fixture(os.path.join(gitroot, "evd", "SHOP-142"))
        _rewrite(d, "REPORT.md", lambda t: t.replace("COMMIT: abc1234", "COMMIT: " + sha))
        expect(run(d, None, DEFAULT_OPTS).ok, "a report naming a real commit was rejected")
        _rewrite(d, "REPORT.md", lambda t: t.replace("COMMIT: " + sha, "COMMIT: deadbee"))
        expect(not run(d, None, DEFAULT_OPTS).ok,
               "a report naming a commit that does not exist did not go red")

    d = fresh("undeclared-oracle")
    expect(not run(d, None, dict(DEFAULT_OPTS, sources=[])).ok,
           "a pack that reached a verdict with no declared oracle did not go red")
    expect(run(d, None, dict(DEFAULT_OPTS, require_citation=False)).ok,
           "require_citation: false did not turn the rule off")

    # 4. a non-UI case WITH its verification file must pass
    d = fresh("nonui")
    _rewrite(d, C1 + "/case.md", lambda t: t.replace("KIND: acceptance", "KIND: acceptance\nTYPE: NON-UI"))
    with open(os.path.join(d, C1, "db_verify.md"), "w", encoding="utf-8") as fh:
        fh.write("SELECT total FROM orders WHERE id=4102;\n-> 450000\n")
    if evd_index is not None:
        evd_index.write(d)
    expect(run(d, None, DEFAULT_OPTS).ok, "a non-UI case with db_verify.md should pass")

    # 5. the pair api_check.mjs writes IS a recorded verification — at the case
    #    root and one folder down, which is how a case with several calls keeps
    #    them. This gate used to demand a file the toolchain never produced.
    def _api_case(root, where):
        case = os.path.join(root, C1)
        _rewrite(root, C1 + "/case.md",
                 lambda t: t.replace("KIND: acceptance", "KIND: acceptance\nTYPE: NON-UI"))
        for f in os.listdir(case):
            if f.lower().endswith(".png"):
                os.remove(os.path.join(case, f))
        target = case if where == "root" else os.path.join(case, "call_1")
        os.makedirs(target, exist_ok=True)
        with open(os.path.join(target, "request.http"), "w", encoding="utf-8") as fh:
            fh.write("POST http://127.0.0.1:4310/orders\ncontent-type: application/json\n\n{}\n")
        with open(os.path.join(target, "response.json"), "w", encoding="utf-8") as fh:
            fh.write('{"status": 201, "body": {"discount": 50000}}\n')
        return target

    for where in ("root", "subfolder"):
        d = fresh("api_{}".format(where))
        _api_case(d, where)
        if evd_index is not None:
            evd_index.write(d)
        expect(run(d, None, DEFAULT_OPTS).ok,
               "a non-UI case whose evidence is request.http + response.json in the {} "
               "should pass".format(where))

    # …and the new rule must still be able to go red: half a pair is not a pair.
    d = fresh("api_half")
    target = _api_case(d, "root")
    os.remove(os.path.join(target, "response.json"))
    if evd_index is not None:
        evd_index.write(d)
    expect(not run(d, None, DEFAULT_OPTS).ok,
           "a request with no recorded response was accepted as verification")

    # A write must still be read back out of the DATABASE. An exchange with the
    # product is the claim being checked, not the check.
    d = fresh("api_readback")
    _api_case(d, "root")
    _rewrite(d, C1 + "/case.md", lambda t: t.replace("KIND: acceptance", "KIND: write-readback"))
    if evd_index is not None:
        evd_index.write(d)
    expect(not run(d, None, DEFAULT_OPTS).ok,
           "a write-readback case was satisfied by a request/response pair instead of a read-back")

    shutil.rmtree(tmp, ignore_errors=True)
    if fails:
        print("evd_check --selftest FAILED")
        for f in fails:
            print("  x {}".format(f))
        return 1
    print("evd_check --selftest passed  ({} mutations, each went red)".format(len(mutations)))
    return 0


def _rewrite_to(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _rewrite(root, rel, fn):
    path = os.path.join(root, rel)
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(fn(text))


def main():
    ap = argparse.ArgumentParser(description="the evidence gate")
    ap.add_argument("--evd", help="evidence folder, e.g. evd/SHOP-142")
    ap.add_argument("--expect-tcs", type=int, default=None,
                    help="the number of cases PLANNED, so 'planned 5, ran 1' goes red")
    ap.add_argument("--selftest", action="store_true", help="prove this gate can fail")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.evd:
        ap.error("--evd is required (or use --selftest)")

    opts = {
        "min_tcs": int(cfg_get("evidence.min_test_cases", 2)),
        "max_tcs": int(cfg_get("evidence.max_test_cases", 5)),
        "require_boundary": bool(cfg_get("evidence.require_boundary", True)),
        "require_whole_screen": bool(cfg_get("evidence.require_whole_screen", True)),
        "require_reload": bool(cfg_get("evidence.require_reload_check", True)),
        "require_annotation": bool(cfg_get("evidence.require_annotation", True)),
        "require_db_verify": bool(cfg_get("evidence.require_db_verify", True)),
        "require_click_entry": True,
        "require_citation": bool(cfg_get("evidence.require_citation", True)),
        "root": _project_root(),
        "config_found": bool(_project_root()),
        "sources": oracle_sources(),
    }
    return report(run(args.evd, args.expect_tcs, opts), args.evd)


if __name__ == "__main__":
    sys.exit(main())
