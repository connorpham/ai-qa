#!/usr/bin/env python3
"""db_verify.py — read a database to VERIFY a write. Never to make one.

The QA lane creates data the way a user creates it, through the product. The
database is where you go afterwards to confirm the row is really there, really
has that value, and really went away when it was supposed to.

So this tool refuses to run anything that could change state. The refusal is the
feature, and it is enforced before a connection is even opened:

    python3 .ai-qa/scripts/db_verify.py --sql check.sql --out evd/SHOP-142/TC_1/db_verify.md
    python3 .ai-qa/scripts/db_verify.py -e "SELECT total FROM orders WHERE id=4102"

Connection comes from the env var named by `database.url_env` in
aiqa.config.yaml — the NAME is in the config, the value never is.

Prove the guard:  python3 db_verify.py --selftest
Python 3.9 compatible.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
try:
    import ctx  # type: ignore
except Exception:
    ctx = None

# Anything that can change state, create state, or move data out of the database.
FORBIDDEN = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate",
    "replace", "merge", "grant", "revoke", "call", "do", "copy", "load",
    "rename", "attach", "detach", "vacuum", "reindex", "set", "reset",
    "begin", "commit", "rollback", "savepoint", "lock", "refresh", "cluster",
    "comment", "import", "export", "pragma", "upsert",
)
ALLOWED_STARTS = ("select", "with", "explain", "show", "describe", "desc", "table", "values")


class Rejected(Exception):
    pass


def strip_comments(sql):
    """Remove -- line comments and /* */ block comments.

    String literals containing '--' are rare in a verification query and being
    over-strict costs a rewrite; being under-strict costs a mutated database.
    The guard errs toward refusing.
    """
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    sql = re.sub(r"--[^\n]*", " ", sql)
    return sql


def statements(sql):
    """Split on semicolons and drop the empties. Deliberately naive: a
    semicolon inside a string literal will be split too, which produces a
    refusal rather than a surprise."""
    return [s.strip() for s in strip_comments(sql).split(";") if s.strip()]


def assert_read_only(sql):
    """Raise Rejected unless this is unambiguously a read.

    Returns the single statement to run.
    """
    stmts = statements(sql)
    if not stmts:
        raise Rejected("empty query")
    if len(stmts) > 1:
        raise Rejected(
            "{} statements in one query. Run one read at a time — batching is how a "
            "write hides behind a SELECT.".format(len(stmts)))

    stmt = stmts[0]
    low = re.sub(r"\s+", " ", stmt.strip().lower())

    head = low.split(" ", 1)[0].strip("(")
    if head not in ALLOWED_STARTS:
        raise Rejected("statement starts with {!r}; only reads are allowed here "
                       "({})".format(head.upper(), ", ".join(s.upper() for s in ALLOWED_STARTS)))

    # A CTE may legally contain a writing statement in PostgreSQL:
    #   WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x
    # It starts with WITH and it destroys data. This is the case the naive
    # "starts with SELECT" check misses, and the reason this function exists.
    for word in FORBIDDEN:
        if re.search(r"\b{}\b".format(re.escape(word)), low):
            raise Rejected(
                "the word {!r} appears in the statement. Even inside a CTE or a subquery "
                "that is a state change — the database is read-only for this lane.".format(word.upper()))

    # SELECT ... INTO creates a table in several dialects.
    if re.search(r"\bselect\b.*\binto\b", low):
        raise Rejected("SELECT ... INTO writes a new table")
    if re.search(r"\bfor\s+update\b|\bfor\s+share\b", low):
        raise Rejected("row locking is a write-side operation")

    return stmt


# ---------------------------------------------------------------------------
def connection_url():
    var = "DATABASE_URL"
    if ctx is not None:
        try:
            var = ctx.get(ctx.load(), "database.url_env", "DATABASE_URL") or "DATABASE_URL"
        except Exception:
            pass
    url = os.environ.get(var, "")
    return var, url


def client_for(url):
    """Pick a command-line client from the URL scheme. Using the standard client
    keeps the recorded command reproducible by a human — they can paste it."""
    if url.startswith(("postgres://", "postgresql://")):
        return ("psql", lambda stmt: ["psql", url, "--no-psqlrc", "-P", "pager=off", "-c", stmt])
    if url.startswith(("mysql://", "mariadb://")):
        return ("mysql", lambda stmt: ["mysql", "--table", "-e", stmt, url])
    if url.startswith("sqlite://") or url.endswith((".db", ".sqlite", ".sqlite3")):
        pathpart = url.replace("sqlite://", "").lstrip("/") or url
        return ("sqlite3", lambda stmt: ["sqlite3", "-header", "-column", pathpart, stmt])
    return (None, None)


def run_query(stmt, url):
    name, build = client_for(url)
    if not name:
        return None, "unsupported database URL scheme — supported: postgres, mysql, sqlite"
    if not shutil.which(name):
        return None, "{} is not installed · unblock: install the {} client".format(name, name)
    proc = subprocess.run(build(stmt), capture_output=True, text=True)
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout or "query failed").strip()
    return proc.stdout.rstrip(), None


def write_evidence(out, stmt, output, error, url_var):
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [
        "# Database verification",
        "",
        "READ-ONLY. This query was checked against the write guard before it ran;",
        "nothing here can change state.",
        "",
        "- **When:** {}".format(stamp),
        "- **Connection:** `${}` (value never recorded)".format(url_var),
        "",
        "## Statement",
        "",
        "```sql",
        stmt,
        "```",
        "",
        "## Result",
        "",
    ]
    if error:
        lines += ["```", "ERROR: {}".format(error), "```", "",
                  "This case is BLOCKED, not failed — the query never ran."]
    else:
        lines += ["```", output if output else "(no rows)", "```"]
    text = "\n".join(lines) + "\n"
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    return text


# ---------------------------------------------------------------------------
GREEN = [
    "SELECT total FROM orders WHERE id = 4102",
    "select * from users where email='a@b.c'",
    "WITH recent AS (SELECT id FROM orders WHERE created_at > now() - interval '1 day') SELECT count(*) FROM recent",
    "EXPLAIN SELECT 1",
    "SHOW TABLES",
    "SELECT total FROM orders WHERE id = 4102;",
    "SELECT o.id, o.total FROM orders o JOIN users u ON u.id = o.user_id WHERE u.role = 'STAFF'",
]

RED = [
    ("DELETE FROM orders WHERE id = 4102", "a bare delete"),
    ("UPDATE orders SET total = 0", "a bare update"),
    ("INSERT INTO orders (id) VALUES (1)", "a bare insert"),
    ("DROP TABLE orders", "a drop"),
    ("TRUNCATE orders", "a truncate"),
    ("SELECT 1; DELETE FROM orders", "a write batched behind a read"),
    ("SELECT 1; -- harmless\nDROP TABLE orders", "a write hidden after a comment"),
    ("WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone", "a delete inside a CTE"),
    ("WITH t AS (UPDATE orders SET total=0 RETURNING *) SELECT count(*) FROM t", "an update inside a CTE"),
    ("SELECT * INTO backup FROM orders", "SELECT ... INTO creating a table"),
    ("SELECT * FROM orders FOR UPDATE", "row locking"),
    ("CREATE TABLE x (id int)", "a create"),
    ("GRANT ALL ON orders TO public", "a grant"),
    ("/* SELECT */ DELETE FROM orders", "a write disguised by a leading comment"),
    ("COPY orders TO '/tmp/out.csv'", "data exfiltration via COPY"),
    ("PRAGMA writable_schema = 1", "a sqlite pragma"),
    ("", "an empty query"),
    ("VACUUM", "a maintenance command"),
]


def selftest():
    fails = []
    for sql in GREEN:
        try:
            assert_read_only(sql)
        except Rejected as e:
            fails.append("false positive — refused a legitimate read: {!r} ({})".format(sql, e))
    for sql, label in RED:
        try:
            assert_read_only(sql)
            fails.append("GUARD HOLE — allowed {}: {!r}".format(label, sql))
        except Rejected:
            pass

    if fails:
        print("db_verify --selftest FAILED")
        for f in fails:
            print("  x {}".format(f))
        return 1
    print("db_verify --selftest passed  ({} reads allowed, {} writes refused)".format(len(GREEN), len(RED)))
    return 0


def main():
    ap = argparse.ArgumentParser(description="read-only database verification")
    ap.add_argument("--sql", help="file containing ONE read statement")
    ap.add_argument("-e", "--execute", help="the statement inline")
    ap.add_argument("--out", help="write the evidence markdown here")
    ap.add_argument("--selftest", action="store_true", help="prove the write guard refuses writes")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.sql:
        with open(args.sql, "r", encoding="utf-8") as fh:
            raw = fh.read()
    elif args.execute:
        raw = args.execute
    else:
        ap.error("pass --sql <file> or -e <statement> (or --selftest)")

    try:
        stmt = assert_read_only(raw)
    except Rejected as e:
        print("DB: REFUSED — {}".format(e))
        print("     The database is read-only for this lane. Create data through the product,")
        print("     under the write gate, and use this tool to confirm what it wrote.")
        return 2

    var, url = connection_url()
    if not url:
        print("DB: BLOCKED — ${} is not set · unblock: export it, or correct database.url_env".format(var))
        write_evidence(args.out, stmt, None, "${} is not set".format(var), var)
        return 1

    output, error = run_query(stmt, url)
    text = write_evidence(args.out, stmt, output, error, var)
    if error:
        print("DB: BLOCKED — {}".format(error))
        return 1
    print("DB: OK")
    if not args.out:
        print(text)
    else:
        print("    evidence: {}".format(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
