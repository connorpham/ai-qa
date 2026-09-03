"""Read aiqa.config.yaml from Python.

This parser and src/cli/config.mjs must agree, so the grammar is deliberately
small enough to hold in your head:

  * 2-space indentation, no tabs
  * key: value  ·  key: [a, b]  ·  key: {}  ·  nested maps  ·  "- item" lists
  * quotes around a scalar are stripped
  * " #" always starts a comment, INCLUDING inside quotes
  * no anchors, no multi-line scalars, no escape sequences

`ai-qa init` validates every value against exactly these rules before writing,
so a config this cannot read is never created.

Python 3.9 compatible — no match statements, no PEP 604 unions at runtime.
"""
import os
import re
from typing import Any, Dict, List, Optional, Union

CONFIG_NAME = "aiqa.config.yaml"

_KV = re.compile(r"^([A-Za-z0-9_.-]+):\s*(.*)$")


def _decomment(line: str) -> str:
    """Strip a trailing comment. ' #' is the delimiter, so a '#' with no space
    before it survives — URLs with fragments and colour hex codes stay intact."""
    i = line.find(" #")
    body = line if i == -1 else line[:i]
    return body.rstrip()


def _scalar(raw: str) -> Any:
    v = raw.strip()
    if not v:
        return ""
    if v.startswith("["):
        end = v.rfind("]")
        inner = (v[1:end] if end != -1 else v[1:]).strip()
        if not inner:
            return []
        return [_scalar(p) for p in inner.split(",")]
    if v == "{}":
        return {}
    if len(v) > 1 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
        return v[1:-1]
    if v == "true":
        return True
    if v == "false":
        return False
    if v in ("null", "~"):
        return None
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"-?\d*\.\d+", v):
        return float(v)
    return v


def parse(text: str) -> Dict[str, Any]:
    lines: List[str] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        line = _decomment(raw)
        if line.strip():
            lines.append(line)

    root: Dict[str, Any] = {}
    # stack entries: (indent, container)
    stack: List[Any] = [(-1, root)]

    for i, line in enumerate(lines):
        indent = len(line) - len(line.lstrip())
        body = line.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]

        if body.startswith("- ") or body == "-":
            if isinstance(container, list):
                container.append(_scalar(body[1:]))
            continue

        m = _KV.match(body)
        if not m:
            continue
        key, rest = m.group(1), m.group(2)

        if rest != "":
            if isinstance(container, dict):
                container[key] = _scalar(rest)
            continue

        # A block follows. Look ahead: the first child decides list vs map.
        child: Union[Dict[str, Any], List[Any]] = {}
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            nxt_indent = len(nxt) - len(nxt.lstrip())
            if nxt_indent <= indent:
                break
            if nxt.strip().startswith("-"):
                child = []
            break
        if isinstance(container, dict):
            container[key] = child
        stack.append((indent, child))

    return root


def find_root(start: Optional[str] = None) -> str:
    """Walk up looking for aiqa.config.yaml; fall back to the start directory."""
    cur = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.exists(os.path.join(cur, CONFIG_NAME)):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return os.path.abspath(start or os.getcwd())
        cur = parent


def load(start: Optional[str] = None) -> Dict[str, Any]:
    root = find_root(start)
    path = os.path.join(root, CONFIG_NAME)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        cfg = parse(fh.read())
    cfg["_root"] = root
    return cfg


def get(cfg: Dict[str, Any], dotted: str, default: Any = None) -> Any:
    """Dotted lookup: get(cfg, 'evidence.require_boundary', True)."""
    cur: Any = cfg
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return default if cur is None else cur


if __name__ == "__main__":
    import json
    import sys

    cfg = load()
    if len(sys.argv) > 1:
        print(get(cfg, sys.argv[1], ""))
    else:
        print(json.dumps(cfg, indent=2, default=str))
