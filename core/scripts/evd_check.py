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
import os
import re
import sys
import shutil
import tempfile

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
KINDS = ("acceptance", "boundary", "whole-screen", "write-readback", "exploratory")

# Fields every case manifest must carry. The names are the discipline: a field
# you have to fill in is a question you cannot skip.
REQUIRED_FIELDS = ("RESULT", "AS", "PRECONDITION", "ENTRY", "STEPS", "EXPECTED", "ACTUAL")
UI_ONLY_FIELDS = ("AFTER", "BACK")

# A step image may carry its case number: TC3_02_total_after_save.png. The
# prefix is what keeps a file legible after someone drags it out of the folder
# and into a ticket, a chat or a slide, which is where evidence actually goes.
STEP_IMAGE = re.compile(r"^(?:TC(\d+)_)?(\d{2})_.+\.(png|jpg|jpeg)$", re.I)
BOXED_IMAGE = re.compile(r"_boxed\.(png|jpg|jpeg)$", re.I)
# TC_<n>_<what_it_proves>. The number orders the case; the words are what make
# `ls evd/SHOP-142` a test plan instead of a row of drawer handles.
CASE_DIR = re.compile(r"^TC_(\d+)(?:_([A-Za-z0-9][A-Za-z0-9_-]*))?$")


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


def check_case(case_dir, res, opts):
    name = os.path.basename(case_dir)
    m = CASE_DIR.match(name)
    case_no = m.group(1) if m else ""
    if m and not m.group(2):
        res.err(name, "the folder is called {} and nothing else — name it TC_{}_<what_it_proves> "
                      "so the reader knows what was tested without opening a file"
                      .format(name, case_no))
    man_path = os.path.join(case_dir, "manifest.md")
    if not os.path.exists(man_path):
        res.err(name, "no manifest.md — a folder of images is not a verification")
        return None

    text = read(man_path)
    f = fields(text)
    kind = f.get("KIND", "").lower()
    non_ui = f.get("TYPE", "").upper() == "NON-UI"

    required = list(REQUIRED_FIELDS) + ([] if non_ui else list(UI_ONLY_FIELDS))
    for key in required:
        if key not in f or not f[key]:
            res.err(name, "manifest.md is missing {} — {}".format(key, _why(key)))

    result = f.get("RESULT", "").upper()
    if result and result not in CASE_RESULTS:
        res.err(name, "RESULT is {!r}; must be one of {}".format(result, "/".join(CASE_RESULTS)))

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

    if opts["require_db_verify"] and kind == "write-readback":
        if not db_verify_files(case_dir):
            res.err(name, "KIND: write-readback with no db_verify.md — the interface saying "
                          "'Saved' is a claim about the interface, not about the data")
    return kind


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
    }.get(key, "required")


def check_report(evd, res):
    path = os.path.join(evd, "REPORT.md")
    if not os.path.exists(path):
        res.err("REPORT.md", "missing — the report is the deliverable; everything else is preparation")
        return
    text = read(path)

    head = text.splitlines()[0] if text.splitlines() else ""
    verdict = next((v for v in VERDICTS if v in head.upper()), "")
    if not verdict:
        res.err("REPORT.md", "the first line carries no verdict; one of {}".format("/".join(VERDICTS)))

    for key, why in (("COMMIT", "the verdict binds to the code it ran against"),
                     ("VERIFIED-AT", "on squash/rebase repos the commit dies with the branch; "
                                     "this timestamp is the fallback anchor"),
                     ("ORACLE", "what 'correct' was compared against — write NONE if nothing was")):
        if not re.search(r"(?im)^\s*{}:\s*\S".format(key), text):
            res.err("REPORT.md", "no {}: line — {}".format(key, why))

    if verdict in ("FAIL", "NEW-BUG", "PARTIAL"):
        if not re.search(r"(?i)severity", text):
            res.err("REPORT.md", "a failing verdict with no Severity — see docs/qa/method/severity.md")
        if not re.search(r"(?i)origin", text):
            res.err("REPORT.md", "a failing verdict with no Origin (DEV or SPEC) — a spec-origin "
                                 "finding sent to a developer produces a fix that is still wrong")

    # Jargon in the body is not fatal, but it is the most common reason a report
    # gets ignored by the person who most needed to read it.
    body = text.split("## Appendix")[0]
    jargon = [w for w in ("stack trace", "null pointer", "controller", "endpoint", "regex", "async")
              if re.search(r"\b{}\b".format(w), body, re.I)]
    if jargon:
        res.warn("REPORT.md", "technical vocabulary in the body ({}) — the bar is a non-programmer "
                              "reading it in two minutes; move it to the appendix".format(", ".join(jargon)))


def run(evd, expect_tcs, opts):
    res = Result()
    if not os.path.isdir(evd):
        res.err(evd, "no such evidence folder")
        return res

    if not os.path.exists(os.path.join(evd, "manifest.md")):
        res.err("manifest.md", "missing at the evidence root — the plain-language index of what was checked")

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
           if fields(read(os.path.join(evd, c, "manifest.md"))).get("RESULT", "").upper() != "BLOCKED"]
    if ran:
        if opts["require_boundary"] and "boundary" not in kinds:
            res.err(evd, "no case with KIND: boundary — the happy path passing tells you nothing "
                         "about the input that must behave the other way")
        if opts["require_whole_screen"] and "whole-screen" not in kinds:
            res.err(evd, "no case with KIND: whole-screen — fixes break neighbours, and the "
                         "neighbour is what users notice")

    # The index is only worth having if it cannot be out of date.
    if evd_index is not None and os.path.exists(os.path.join(evd, "manifest.md")):
        why = evd_index.stale(evd)
        if why:
            res.err("manifest.md", "{} — the folder cannot introduce itself. Run: "
                                   "python3 .ai-qa/scripts/evd_index.py --evd {}".format(why, evd))

    check_report(evd, res)

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


def _mkcase(root, name, manifest, images=True):
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "manifest.md"), "w", encoding="utf-8") as fh:
        fh.write(manifest)
    if images:
        pre = "TC{}_".format(CASE_DIR.match(name).group(1)) if CASE_DIR.match(name) else ""
        for fn in ("01_orders_list.png", "03_total_after_save.png", "03_total_after_save_boxed.png"):
            with open(os.path.join(d, pre + fn), "wb") as fh:
                fh.write(b"\x89PNG\r\n\x1a\n")
    return d


def _green_fixture(root):
    os.makedirs(root, exist_ok=True)
    for n, t in (("manifest.md", "# SHOP-142\nWhat was checked, in plain language.\n"),
                 ("REPORT.md", GREEN_REPORT),
                 ("verifysheet.md", "EXPECTED per spec 3.2\n"),
                 ("debate.md", "verifier card\nchallenger card\nresolution\n")):
        with open(os.path.join(root, n), "w", encoding="utf-8") as fh:
            fh.write(t)
    _mkcase(root, C1, GREEN_CASE)
    _mkcase(root, C2, BOUNDARY_CASE)
    _mkcase(root, C3, SCREEN_CASE)
    if evd_index is not None:
        evd_index.write(root)
    return root


DEFAULT_OPTS = {
    "min_tcs": 2, "max_tcs": 5, "require_boundary": True, "require_whole_screen": True,
    "require_reload": True, "require_annotation": True, "require_db_verify": True,
    "require_click_entry": True,
}


def selftest():
    tmp = tempfile.mkdtemp(prefix="aiqa-evd-")
    fails = []

    def expect(cond, msg):
        if not cond:
            fails.append(msg)

    def fresh(name):
        d = os.path.join(tmp, name)
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
        ("missing root manifest", lambda d: os.remove(os.path.join(d, "manifest.md"))),
        ("no COMMIT line", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("COMMIT: abc1234\n", ""))),
        ("no ORACLE line", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("ORACLE: docs/specs/orders.md 3.2\n", ""))),
        ("FAIL without severity", lambda d: _rewrite(d, "REPORT.md", lambda t: t.replace("— PASS", "— FAIL"))),
        ("no boundary case", lambda d: _rewrite(d, C2 + "/manifest.md", lambda t: t.replace("KIND: boundary", "KIND: acceptance"))),
        ("no whole-screen case", lambda d: _rewrite(d, C3 + "/manifest.md", lambda t: t.replace("KIND: whole-screen", "KIND: acceptance"))),
        ("case missing AS", lambda d: _rewrite(d, C1 + "/manifest.md", lambda t: re.sub(r"(?m)^AS:.*\n", "", t))),
        ("case missing EXPECTED", lambda d: _rewrite(d, C1 + "/manifest.md", lambda t: re.sub(r"(?m)^EXPECTED:.*\n", "", t))),
        ("case missing BACK", lambda d: _rewrite(d, C1 + "/manifest.md", lambda t: re.sub(r"(?m)^BACK:.*\n", "", t))),
        ("ENTRY is only a URL", lambda d: _rewrite(d, C1 + "/manifest.md",
            lambda t: re.sub(r"(?m)^ENTRY:.*$", "ENTRY: http://localhost:3000/orders/4102/edit", t))),
        ("AFTER never reloads", lambda d: _rewrite(d, C1 + "/manifest.md",
            lambda t: re.sub(r"(?m)^AFTER:.*$", "AFTER: the list row shows 3", t))),
        ("no boxed image", lambda d: os.remove(os.path.join(d, C1, "TC1_03_total_after_save_boxed.png"))),
        ("no step screenshots", lambda d: [os.remove(os.path.join(d, C1, f))
                                           for f in os.listdir(os.path.join(d, C1)) if f.endswith(".png")]),
        ("bad RESULT value", lambda d: _rewrite(d, C1 + "/manifest.md", lambda t: t.replace("RESULT: PASS", "RESULT: OK"))),
        ("BLOCKED with no way out", lambda d: _rewrite(d, C1 + "/manifest.md", lambda t: t.replace("RESULT: PASS", "RESULT: BLOCKED"))),
        ("write-readback with no db_verify", lambda d: _rewrite(d, C1 + "/manifest.md",
            lambda t: t.replace("KIND: acceptance", "KIND: write-readback"))),
        ("non-UI with no verification file", lambda d: _rewrite(d, C1 + "/manifest.md",
            lambda t: t.replace("KIND: acceptance", "KIND: acceptance\nTYPE: NON-UI"))),
        ("only one case", lambda d: [shutil.rmtree(os.path.join(d, C2)), shutil.rmtree(os.path.join(d, C3))]),
        ("case folder with no name", lambda d: os.rename(os.path.join(d, C2), os.path.join(d, "TC_2"))),
        ("two folders claiming case 2", lambda d: shutil.copytree(os.path.join(d, C2),
            os.path.join(d, "TC_2_quantity_zero_is_rejected"))),
        ("an image from another case", lambda d: shutil.copyfile(
            os.path.join(d, C1, "TC1_01_orders_list.png"),
            os.path.join(d, C1, "TC9_01_orders_list.png"))),
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
    _rewrite(d, C1 + "/manifest.md", lambda t: t.replace("RESULT: PASS", "RESULT: BLOCKED")
             + "REASON: no account has refund permission\nUNBLOCK: ops to grant refund role to qa@demo\n")
    if evd_index is not None:
        evd_index.write(d)
    expect(run(d, None, DEFAULT_OPTS).ok, "a fully-declared BLOCKED case should not red the gate")

    # 4. a non-UI case WITH its verification file must pass
    d = fresh("nonui")
    _rewrite(d, C1 + "/manifest.md", lambda t: t.replace("KIND: acceptance", "KIND: acceptance\nTYPE: NON-UI"))
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
        _rewrite(root, C1 + "/manifest.md",
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
    _rewrite(d, C1 + "/manifest.md", lambda t: t.replace("KIND: acceptance", "KIND: write-readback"))
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
    }
    return report(run(args.evd, args.expect_tcs, opts), args.evd)


if __name__ == "__main__":
    sys.exit(main())
