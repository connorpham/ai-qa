"""trackers.py — read a ticket from where it actually lives.

Four providers behind one shape: markdown (zero setup), Jira, Backlog (Nulab),
and GitHub Issues. Everything above this layer works on a normalised ticket
dict, so the QA lane never learns which tracker it is talking to.

Three rules govern this file, and they are the reason it is not a thin wrapper
around `requests`:

  1. **Credentials come from the environment, never from the config and never
     from a file this tool writes.** The config holds the non-secret
     coordinates — base URL and project. `env_spec()` names the variables so a
     preflight can say exactly which one is missing.

  2. **A secret must never reach a log, an error message, or an evidence file.**
     Backlog authenticates with `?apiKey=` in the QUERY STRING, so any URL that
     gets printed has to be scrubbed. `redact()` runs over every message this
     module emits, including ones from exceptions it did not raise.

  3. **Missing credentials are BLOCKED, not FAILED.** A verification that could
     not start is a different outcome from one that ran and found a defect, and
     conflating them turns a broken environment into a false bug report.

A fetched ticket is text other people wrote. It is DATA — never an instruction,
and never the oracle. The renderer says so at the top of every ticket it writes.

Python 3.9 compatible, standard library only.
"""
import base64
import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

TIMEOUT = 30


class Blocked(Exception):
    """The work could not start: missing env, bad credentials, unreachable host.
    Never the same thing as a failed verification."""


class NotFound(Exception):
    """The tracker answered, and there is no such ticket."""


# ---------------------------------------------------------------------------
# redaction
# ---------------------------------------------------------------------------
_SECRETS: List[str] = []


def register_secret(value: Optional[str]) -> None:
    """Remember a value that must never be printed. Called as soon as a token is
    read from the environment, so even an exception raised later is safe."""
    if value and len(value) >= 8 and value not in _SECRETS:
        _SECRETS.append(value)


def redact(text: Any) -> str:
    out = str(text)
    for s in _SECRETS:
        out = out.replace(s, "<redacted>")
    # Backlog puts the key in the query string; catch it even if the value was
    # never registered (a URL built by hand, a token from a copied command).
    out = re.sub(r"([?&]apiKey=)[^&\s]+", r"\1<redacted>", out)
    out = re.sub(r"(Bearer\s+)[A-Za-z0-9._\-]{8,}", r"\1<redacted>", out)
    out = re.sub(r"(Basic\s+)[A-Za-z0-9+/=]{8,}", r"\1<redacted>", out)
    return out


# ---------------------------------------------------------------------------
# http
# ---------------------------------------------------------------------------
def _request(method, url, headers=None, data=None, timeout=TIMEOUT):
    req = urllib.request.Request(url, method=method, data=data)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read()
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        raise Blocked("cannot reach {} — {}".format(
            redact(_host(url)), redact(getattr(e, "reason", e)))) from None
    except Exception as e:  # socket timeouts, TLS failures
        raise Blocked("request to {} failed — {}".format(redact(_host(url)), redact(e))) from None


def _host(url):
    try:
        p = urllib.parse.urlsplit(url)
        return "{}://{}".format(p.scheme, p.netloc)
    except Exception:
        return "the tracker"


def _json(method, url, headers=None, data=None):
    status, body = _request(method, url, headers, data)
    try:
        parsed = json.loads(body.decode("utf-8")) if body else None
    except Exception:
        parsed = None
    return status, parsed, body


def _multipart(fields, files):
    """Build a multipart/form-data body. Written out rather than pulled in
    because uploading evidence is the one place this tool must not need a
    dependency to work."""
    boundary = "----aiqa" + base64.b16encode(os.urandom(8)).decode("ascii")
    out = bytearray()
    for name, value in (fields or {}).items():
        out += b"--" + boundary.encode() + b"\r\n"
        out += 'Content-Disposition: form-data; name="{}"\r\n\r\n'.format(name).encode()
        out += str(value).encode("utf-8") + b"\r\n"
    for name, filename, content in (files or []):
        out += b"--" + boundary.encode() + b"\r\n"
        out += ('Content-Disposition: form-data; name="{}"; filename="{}"\r\n'
                .format(name, os.path.basename(filename)).encode())
        out += b"Content-Type: application/octet-stream\r\n\r\n"
        out += content + b"\r\n"
    out += b"--" + boundary.encode() + b"--\r\n"
    return bytes(out), "multipart/form-data; boundary=" + boundary


# ---------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------
class Tracker:
    id = "base"
    #  (VAR, required, what it is / where to get it)
    ENV: List[Tuple[str, bool, str]] = []

    def __init__(self, cfg, root):
        self.cfg = cfg or {}
        self.root = root
        tr = self.cfg.get("tracker") if isinstance(self.cfg.get("tracker"), dict) else {}
        self.base_url = str(tr.get("base_url", "") or "").rstrip("/")
        self.project = str(tr.get("project", "") or "")
        self.done_statuses = tr.get("done_statuses") or ["Done", "Closed", "Resolved"]
        self.review_status = tr.get("review_status") or "In Review"

    # -- env ---------------------------------------------------------------
    @classmethod
    def env_spec(cls):
        return list(cls.ENV)

    def env(self, name):
        v = os.environ.get(name, "").strip()
        register_secret(v)
        return v

    def missing_env(self):
        return [name for name, required, _ in self.ENV if required and not os.environ.get(name, "").strip()]

    def require_ready(self, *coords):
        """Report EVERY missing prerequisite at once.

        Reporting them one at a time makes setup a sequence of fix-rerun-fix,
        and the person doing it is already annoyed that it did not just work.
        """
        problems = []
        for f in coords:
            if not getattr(self, f, ""):
                problems.append(
                    "tracker.{} is not set in aiqa.config.yaml — a non-secret coordinate, "
                    "so it belongs in the config, not the environment".format(f))
        missing = self.missing_env()
        if missing:
            problems.append("missing environment variable(s): {}".format(", ".join(missing)))
            for name, _req, desc in self.ENV:
                if name in missing:
                    problems.append("  {} — {}".format(name, desc))
        if problems:
            raise Blocked("\n".join(problems))

    # Kept as thin aliases so a provider can express intent at the call site.
    def require_env(self):
        self.require_ready()

    def require_coords(self, *fields):
        self.require_ready(*fields)

    # -- interface ---------------------------------------------------------
    def check(self):
        raise NotImplementedError

    def get(self, key):
        raise NotImplementedError

    def comment(self, key, body):
        raise Blocked("{}: posting comments is not supported".format(self.id))

    def attach(self, key, paths):
        raise Blocked("{}: attachments are not supported".format(self.id))

    def transition(self, key, status):
        raise Blocked("{}: transitions are not supported".format(self.id))


def _blank_ticket(key, provider):
    return {
        "key": key, "provider": provider, "title": "", "description": "",
        "status": "", "assignee": "", "reporter": "", "type": "", "labels": [],
        "url": "", "created": "", "updated": "", "comments": [], "attachments": [],
        # Header-shaped lines found in the body, which are deliberately NOT
        # adopted as fields. The readiness note names them so "no status" can be
        # told apart from "a status this file put somewhere I do not read".
        "stray_fields": [],
    }


# ---------------------------------------------------------------------------
# markdown — the zero-setup default
# ---------------------------------------------------------------------------
class Markdown(Tracker):
    """Tickets as files under docs/qa/tickets/<KEY>.md.

    No credentials, no network, and the whole ticket history is in git. For a
    small team this is not a downgrade — it is the only option where the ticket
    and the verdict live in the same reviewable place.
    """
    id = "markdown"
    ENV = []

    def _dir(self):
        paths = self.cfg.get("paths") if isinstance(self.cfg.get("paths"), dict) else {}
        qa = str(paths.get("qa", "docs/qa"))
        return os.path.join(self.root, qa, "tickets")

    def _path(self, key):
        return os.path.join(self._dir(), "{}.md".format(key))

    def check(self):
        d = self._dir()
        if not os.path.isdir(d):
            return False, "no ticket folder yet at {} — create one and add <KEY>.md files".format(
                os.path.relpath(d, self.root))
        n = len([f for f in os.listdir(d) if f.endswith(".md")])
        return True, "{} ticket file(s) in {}".format(n, os.path.relpath(d, self.root))

    def get(self, key):
        path = self._path(key)
        if not os.path.exists(path):
            raise NotFound("no ticket file at {}".format(os.path.relpath(path, self.root)))
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        t = _blank_ticket(key, self.id)
        t["url"] = path
        # Front-matter-ish "Key: value" header lines, then the body.
        #
        # Blank lines inside the header block are SKIPPED rather than treated as
        # the start of the body. Everyone writes a blank line under a heading,
        # and when that ended the header block the ticket's own `Status:` line
        # was read as prose: /qa then called a ticket marked "Ready for QA"
        # BLOCKED (not delivered). The header ends at the first line that is
        # neither blank, nor the title, nor `Key: value`.
        HEADER = re.compile(r"^\s*(Status|Assignee|Reporter|Type|Labels|Title|Summary):\s*(.*)$", re.I)
        body_lines = []
        in_header = True
        for line in text.splitlines():
            if in_header:
                if not line.strip():
                    continue
                m = HEADER.match(line)
                if m:
                    field, value = m.group(1).lower(), m.group(2).strip()
                    if field in ("title", "summary"):
                        t["title"] = value
                    elif field == "labels":
                        t["labels"] = [s.strip() for s in value.split(",") if s.strip()]
                    else:
                        t[field] = value
                    continue
                if line.startswith("# ") and not t["title"]:
                    t["title"] = line[2:].strip()
                    continue
                in_header = False
            body_lines.append(line)
        t["description"] = "\n".join(body_lines).strip()
        # A header field written further down the file is NOT adopted — that
        # would make any sentence starting "Status:" change a verdict — but the
        # readiness note needs to be able to say why a field it can see was not
        # read, instead of reporting it as absent.
        t["stray_fields"] = sorted({
            HEADER.match(l).group(1).capitalize()
            for l in body_lines if HEADER.match(l)
        })
        return t

    def comment(self, key, body):
        path = self._path(key)
        if not os.path.exists(path):
            raise NotFound("no ticket file at {}".format(os.path.relpath(path, self.root)))
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n\n---\n\n### QA comment\n\n{}\n".format(body))
        return path


# ---------------------------------------------------------------------------
# Jira
# ---------------------------------------------------------------------------
def adf_text(node):
    """Flatten Atlassian Document Format to plain text.

    Jira Cloud's v3 API returns descriptions as a JSON tree. We read through v2
    (which returns a string) but an instance can still hand back ADF, and a
    description rendered as `{'type': 'doc', ...}` in a verify sheet is a
    verification working from garbage.
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_text(n) for n in node)
    if not isinstance(node, dict):
        return str(node)

    kind = node.get("type")
    if kind == "text":
        return node.get("text", "")
    if kind == "hardBreak":
        return "\n"
    if kind == "mention":
        return "@" + str((node.get("attrs") or {}).get("text", "")).lstrip("@")
    if kind == "inlineCard":
        return str((node.get("attrs") or {}).get("url", ""))
    if kind == "emoji":
        return str((node.get("attrs") or {}).get("shortName", ""))

    inner = adf_text(node.get("content"))
    if kind in ("paragraph", "heading", "codeBlock", "blockquote", "panel"):
        return inner + "\n"
    if kind == "listItem":
        return "- " + inner.strip() + "\n"
    if kind == "rule":
        return "---\n"
    if kind == "table":
        return inner + "\n"
    if kind in ("tableRow",):
        return inner.strip() + "\n"
    if kind in ("tableCell", "tableHeader"):
        return inner.strip() + " | "
    return inner


class Jira(Tracker):
    """Jira Cloud, REST API v2.

    v2 returns descriptions and comments as plain strings; v3 returns ADF trees.
    Reading through v2 keeps a verify sheet readable without a converter, and
    `adf_text()` covers instances that hand back ADF anyway.
    """
    id = "jira"
    ENV = [
        ("JIRA_EMAIL", True, "the account email the API token belongs to"),
        ("JIRA_API_TOKEN", True, "create at id.atlassian.com → Security → API tokens"),
    ]

    def _auth(self):
        self.require_ready("base_url")
        email = self.env("JIRA_EMAIL")
        token = self.env("JIRA_API_TOKEN")
        raw = "{}:{}".format(email, token).encode("utf-8")
        basic = base64.b64encode(raw).decode("ascii")
        register_secret(basic)
        return {"Authorization": "Basic " + basic, "Accept": "application/json"}

    def _api(self, path):
        return "{}/rest/api/2{}".format(self.base_url, path)

    def check(self):
        h = self._auth()
        status, data, _ = _json("GET", self._api("/myself"), h)
        if status == 200 and isinstance(data, dict):
            return True, "authenticated as {} on {}".format(
                data.get("displayName") or data.get("emailAddress") or "?", _host(self.base_url))
        if status in (401, 403):
            raise Blocked("Jira rejected the credentials (HTTP {}) — check JIRA_EMAIL and "
                          "JIRA_API_TOKEN, and that the account can see {}".format(status, self.project or "the project"))
        raise Blocked("Jira /myself returned HTTP {}".format(status))

    def get(self, key):
        h = self._auth()
        status, data, _ = _json("GET", self._api("/issue/{}?expand=renderedFields".format(
            urllib.parse.quote(key))), h)
        if status == 404:
            raise NotFound("Jira has no issue {}".format(key))
        if status in (401, 403):
            raise Blocked("not permitted to read {} (HTTP {})".format(key, status))
        if status != 200 or not isinstance(data, dict):
            raise Blocked("Jira returned HTTP {} for {}".format(status, key))

        f = data.get("fields") or {}
        t = _blank_ticket(data.get("key", key), self.id)
        t["title"] = f.get("summary") or ""
        t["description"] = adf_text(f.get("description")).strip()
        t["status"] = ((f.get("status") or {}).get("name")) or ""
        t["assignee"] = ((f.get("assignee") or {}).get("displayName")) or ""
        t["reporter"] = ((f.get("reporter") or {}).get("displayName")) or ""
        t["type"] = ((f.get("issuetype") or {}).get("name")) or ""
        t["labels"] = f.get("labels") or []
        t["created"] = f.get("created") or ""
        t["updated"] = f.get("updated") or ""
        t["url"] = "{}/browse/{}".format(self.base_url, t["key"])
        for a in (f.get("attachment") or []):
            t["attachments"].append({
                "name": a.get("filename", ""), "size": a.get("size", 0),
                "url": a.get("content", ""),
            })

        st, cdata, _ = _json("GET", self._api("/issue/{}/comment".format(urllib.parse.quote(key))), h)
        if st == 200 and isinstance(cdata, dict):
            for cm in cdata.get("comments") or []:
                t["comments"].append({
                    "author": ((cm.get("author") or {}).get("displayName")) or "",
                    "created": cm.get("created", ""),
                    "body": adf_text(cm.get("body")).strip(),
                })
        return t

    def comment(self, key, body):
        h = self._auth()
        h["Content-Type"] = "application/json"
        payload = json.dumps({"body": body}).encode("utf-8")
        status, data, raw = _json("POST", self._api("/issue/{}/comment".format(
            urllib.parse.quote(key))), h, payload)
        if status in (200, 201):
            return "{}/browse/{}".format(self.base_url, key)
        raise Blocked("Jira refused the comment on {} (HTTP {}): {}".format(
            key, status, redact((raw or b"").decode("utf-8", "replace")[:300])))

    def attach(self, key, paths):
        h = self._auth()
        # Jira requires this header on uploads; without it the request is
        # rejected as a suspected XSRF attempt, with a misleading message.
        h["X-Atlassian-Token"] = "no-check"
        files = []
        for p in paths:
            with open(p, "rb") as fh:
                files.append(("file", p, fh.read()))
        body, ctype = _multipart({}, files)
        h["Content-Type"] = ctype
        status, data, raw = _json("POST", self._api("/issue/{}/attachments".format(
            urllib.parse.quote(key))), h, body)
        if status in (200, 201) and isinstance(data, list):
            return [a.get("filename", "") for a in data]
        raise Blocked("Jira refused the attachments on {} (HTTP {}): {}".format(
            key, status, redact((raw or b"").decode("utf-8", "replace")[:300])))

    def transition(self, key, status_name):
        h = self._auth()
        st, data, _ = _json("GET", self._api("/issue/{}/transitions".format(
            urllib.parse.quote(key))), h)
        if st != 200 or not isinstance(data, dict):
            raise Blocked("could not read the transitions for {} (HTTP {})".format(key, st))
        options = data.get("transitions") or []
        target = None
        for tr in options:
            to_name = ((tr.get("to") or {}).get("name")) or tr.get("name") or ""
            if to_name.strip().lower() == status_name.strip().lower():
                target = tr
                break
        if target is None:
            names = ", ".join(sorted({((t.get("to") or {}).get("name")) or t.get("name") or "" for t in options}))
            raise Blocked("{} cannot move to {!r} from {}. Available: {}".format(
                key, status_name, "its current status", names or "(none)"))
        h["Content-Type"] = "application/json"
        payload = json.dumps({"transition": {"id": target.get("id")}}).encode("utf-8")
        st, _d, raw = _json("POST", self._api("/issue/{}/transitions".format(
            urllib.parse.quote(key))), h, payload)
        if st in (200, 204):
            return "{} → {}".format(key, status_name)
        raise Blocked("Jira refused the transition (HTTP {}): {}".format(
            st, redact((raw or b"").decode("utf-8", "replace")[:300])))


# ---------------------------------------------------------------------------
# Backlog (Nulab)
# ---------------------------------------------------------------------------
class Backlog(Tracker):
    """Backlog by Nulab, API v2.

    Authentication is `?apiKey=` in the query string, which means the key ends
    up inside every URL this class builds. Nothing here prints a URL that has
    not been through `redact()` — see the module docstring, rule 2.

    `tracker.base_url` is the space URL, e.g. https://yourspace.backlog.com
    (or .jp / .com.br — Nulab uses several domains, so it is configured, not
    assembled from a space name).
    """
    id = "backlog"
    ENV = [
        ("BACKLOG_API_KEY", True, "Backlog → personal settings → API → register a new key"),
    ]

    def _key(self):
        self.require_ready("base_url")
        return self.env("BACKLOG_API_KEY")

    def _api(self, path, params=None):
        q = dict(params or {})
        q["apiKey"] = self._key()
        return "{}/api/v2{}?{}".format(self.base_url, path, urllib.parse.urlencode(q))

    def check(self):
        status, data, _ = _json("GET", self._api("/users/myself"), {"Accept": "application/json"})
        if status == 200 and isinstance(data, dict):
            return True, "authenticated as {} on {}".format(
                data.get("name") or data.get("userId") or "?", _host(self.base_url))
        if status in (401, 403):
            raise Blocked("Backlog rejected the API key (HTTP {}) — check BACKLOG_API_KEY and "
                          "that tracker.base_url is your space URL".format(status))
        raise Blocked("Backlog /users/myself returned HTTP {}".format(status))

    def get(self, key):
        h = {"Accept": "application/json"}
        status, data, _ = _json("GET", self._api("/issues/{}".format(urllib.parse.quote(key))), h)
        if status == 404:
            raise NotFound("Backlog has no issue {}".format(key))
        if status in (401, 403):
            raise Blocked("not permitted to read {} (HTTP {})".format(key, status))
        if status != 200 or not isinstance(data, dict):
            raise Blocked("Backlog returned HTTP {} for {}".format(status, key))

        t = _blank_ticket(data.get("issueKey", key), self.id)
        t["title"] = data.get("summary") or ""
        t["description"] = (data.get("description") or "").strip()
        t["status"] = ((data.get("status") or {}).get("name")) or ""
        t["assignee"] = ((data.get("assignee") or {}).get("name")) or ""
        t["reporter"] = ((data.get("createdUser") or {}).get("name")) or ""
        t["type"] = ((data.get("issueType") or {}).get("name")) or ""
        t["labels"] = [c.get("name", "") for c in (data.get("category") or [])]
        t["created"] = data.get("created") or ""
        t["updated"] = data.get("updated") or ""
        t["url"] = "{}/view/{}".format(self.base_url, t["key"])
        for a in (data.get("attachments") or []):
            t["attachments"].append({
                "name": a.get("name", ""), "size": a.get("size", 0),
                "url": "{}/downloadAttachment/{}".format(self.base_url, a.get("id", "")),
            })

        st, cdata, _ = _json("GET", self._api("/issues/{}/comments".format(
            urllib.parse.quote(key)), {"count": "100", "order": "asc"}), h)
        if st == 200 and isinstance(cdata, list):
            for cm in cdata:
                content = (cm.get("content") or "").strip()
                if not content:
                    continue  # Backlog logs field changes as empty-content comments
                t["comments"].append({
                    "author": ((cm.get("createdUser") or {}).get("name")) or "",
                    "created": cm.get("created", ""),
                    "body": content,
                })
        return t

    def comment(self, key, body):
        data = urllib.parse.urlencode({"content": body}).encode("utf-8")
        h = {"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"}
        status, _d, raw = _json("POST", self._api("/issues/{}/comments".format(
            urllib.parse.quote(key))), h, data)
        if status in (200, 201):
            return "{}/view/{}".format(self.base_url, key)
        raise Blocked("Backlog refused the comment on {} (HTTP {}): {}".format(
            key, status, redact((raw or b"").decode("utf-8", "replace")[:300])))

    def attach(self, key, paths):
        """Two steps: upload to the space, then link the ids to the issue."""
        ids = []
        names = []
        for p in paths:
            with open(p, "rb") as fh:
                body, ctype = _multipart({}, [("file", p, fh.read())])
            status, data, raw = _json("POST", self._api("/space/attachment"),
                                      {"Content-Type": ctype, "Accept": "application/json"}, body)
            if status not in (200, 201) or not isinstance(data, dict):
                raise Blocked("Backlog refused the upload of {} (HTTP {}): {}".format(
                    os.path.basename(p), status, redact((raw or b"").decode("utf-8", "replace")[:200])))
            ids.append(data.get("id"))
            names.append(data.get("name") or os.path.basename(p))

        fields = [("attachmentId[]", str(i)) for i in ids]
        data = urllib.parse.urlencode(fields).encode("utf-8")
        status, _d, raw = _json("PATCH", self._api("/issues/{}".format(urllib.parse.quote(key))),
                                {"Content-Type": "application/x-www-form-urlencoded",
                                 "Accept": "application/json"}, data)
        if status != 200:
            raise Blocked("uploaded {} file(s) but Backlog refused to link them to {} "
                          "(HTTP {})".format(len(ids), key, status))
        return names

    def transition(self, key, status_name):
        h = {"Accept": "application/json"}
        self.require_coords("project")
        st, statuses, _ = _json("GET", self._api("/projects/{}/statuses".format(
            urllib.parse.quote(self.project))), h)
        if st != 200 or not isinstance(statuses, list):
            raise Blocked("could not read the statuses of project {} (HTTP {})".format(self.project, st))
        target = next((s for s in statuses
                       if str(s.get("name", "")).strip().lower() == status_name.strip().lower()), None)
        if target is None:
            raise Blocked("project {} has no status {!r}. Available: {}".format(
                self.project, status_name, ", ".join(str(s.get("name")) for s in statuses)))
        data = urllib.parse.urlencode({"statusId": target.get("id")}).encode("utf-8")
        st, _d, raw = _json("PATCH", self._api("/issues/{}".format(urllib.parse.quote(key))),
                            {"Content-Type": "application/x-www-form-urlencoded",
                             "Accept": "application/json"}, data)
        if st == 200:
            return "{} → {}".format(key, status_name)
        raise Blocked("Backlog refused the transition (HTTP {}): {}".format(
            st, redact((raw or b"").decode("utf-8", "replace")[:300])))


# ---------------------------------------------------------------------------
# GitHub Issues
# ---------------------------------------------------------------------------
class GitHub(Tracker):
    """GitHub Issues. `tracker.project` is owner/repo; the key is the number,
    with or without a leading #."""
    id = "github"
    ENV = [
        ("GITHUB_TOKEN", True, "a token with `repo` scope (gh auth token prints one)"),
    ]

    def _h(self):
        self.require_ready("project")
        token = self.env("GITHUB_TOKEN")
        return {"Authorization": "Bearer " + token,
                "Accept": "application/vnd.github+json",
                "User-Agent": "ai-qa"}

    def _num(self, key):
        m = re.search(r"(\d+)$", str(key))
        if not m:
            raise Blocked("{!r} is not a GitHub issue number".format(key))
        return m.group(1)

    def _api(self, path):
        base = self.base_url or "https://api.github.com"
        return "{}/repos/{}{}".format(base, self.project, path)

    def check(self):
        h = self._h()
        status, data, _ = _json("GET", self._api(""), h)
        if status == 200 and isinstance(data, dict):
            return True, "can read {}".format(data.get("full_name", self.project))
        if status in (401, 403):
            raise Blocked("GitHub rejected the token (HTTP {}) — check GITHUB_TOKEN's scopes".format(status))
        if status == 404:
            raise Blocked("no repository {} visible to this token".format(self.project))
        raise Blocked("GitHub returned HTTP {}".format(status))

    def get(self, key):
        h = self._h()
        n = self._num(key)
        status, data, _ = _json("GET", self._api("/issues/{}".format(n)), h)
        if status == 404:
            raise NotFound("no issue #{} in {}".format(n, self.project))
        if status != 200 or not isinstance(data, dict):
            raise Blocked("GitHub returned HTTP {} for issue #{}".format(status, n))

        t = _blank_ticket("#{}".format(n), self.id)
        t["title"] = data.get("title") or ""
        t["description"] = (data.get("body") or "").strip()
        t["status"] = data.get("state") or ""
        t["assignee"] = ((data.get("assignee") or {}).get("login")) or ""
        t["reporter"] = ((data.get("user") or {}).get("login")) or ""
        t["type"] = "issue"
        t["labels"] = [l.get("name", "") for l in (data.get("labels") or [])]
        t["created"] = data.get("created_at") or ""
        t["updated"] = data.get("updated_at") or ""
        t["url"] = data.get("html_url") or ""

        st, cdata, _ = _json("GET", self._api("/issues/{}/comments?per_page=100".format(n)), h)
        if st == 200 and isinstance(cdata, list):
            for cm in cdata:
                t["comments"].append({
                    "author": ((cm.get("user") or {}).get("login")) or "",
                    "created": cm.get("created_at", ""),
                    "body": (cm.get("body") or "").strip(),
                })
        return t

    def comment(self, key, body):
        h = self._h()
        h["Content-Type"] = "application/json"
        n = self._num(key)
        payload = json.dumps({"body": body}).encode("utf-8")
        status, data, raw = _json("POST", self._api("/issues/{}/comments".format(n)), h, payload)
        if status in (200, 201) and isinstance(data, dict):
            return data.get("html_url", "")
        raise Blocked("GitHub refused the comment (HTTP {}): {}".format(
            status, redact((raw or b"").decode("utf-8", "replace")[:300])))


PROVIDERS = {p.id: p for p in (Markdown, Jira, Backlog, GitHub)}


def build(cfg, root):
    tr = cfg.get("tracker") if isinstance(cfg.get("tracker"), dict) else {}
    name = str(tr.get("provider", "markdown") or "markdown")
    if name not in PROVIDERS:
        raise Blocked("unknown tracker provider {!r} — valid: {}".format(
            name, ", ".join(sorted(PROVIDERS))))
    return PROVIDERS[name](cfg, root)
