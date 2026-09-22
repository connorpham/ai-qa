#!/usr/bin/env python3
"""specs_ingest.py — Ingest & convert external/binary design specs into Git-tracked Markdown.

Turns external specification files (e.g. Excel screen designs, PRD documents) into
version-tracked Markdown files inside `docs/specs/` with timestamps, author attribution,
and detailed update history (changelog).

Usage:
    python3 .ai-qa/scripts/specs_ingest.py --source <dir|file> [--out docs/specs]
    python3 .ai-qa/scripts/specs_ingest.py --audit [--specs docs/specs]
    python3 .ai-qa/scripts/specs_ingest.py --selftest

Python 3.9 compatible.
"""
import argparse
import os
import re
import sys
import shutil
import tempfile
from datetime import datetime

try:
    import openpyxl  # type: ignore
except ImportError:
    openpyxl = None


def clean_val(c):
    if c is None:
        return ""
    val = str(c).strip()
    return val.replace("\r\n", " ").replace("\n", " ").replace("|", "\\|")


def parse_xlsx_spec(file_path):
    """Extract structured data from an Excel design specification file."""
    if openpyxl is None:
        raise RuntimeError("openpyxl is required to parse .xlsx files. Run: pip install openpyxl")

    wb = openpyxl.load_workbook(file_path, data_only=True, read_only=True)
    sheet_names = wb.sheetnames

    fname = os.path.basename(file_path)
    spec_id_m = re.search(r"(SC-[A-Z0-9]+-[A-Z0-9]+|[A-Z]{2,}-[A-Z0-9_-]+)", fname)
    spec_id = spec_id_m.group(1) if spec_id_m else os.path.splitext(fname)[0]

    title_m = re.search(r"(?:画面設計書|設計書|仕様書)[_-](.+?)\.xlsx", fname)
    title = title_m.group(1) if title_m else os.path.splitext(fname)[0]

    file_mtime = datetime.fromtimestamp(os.path.getmtime(file_path)).strftime("%Y-%m-%d %H:%M:%S")

    # 1. Update history / changelog
    history = []
    latest_version = "1.0"
    latest_author = ""
    latest_change = "Initial creation"
    latest_date = file_mtime

    for sname in ("更新履歴", "変更履歴", "History", "Changelog"):
        if sname in sheet_names:
            sheet = wb[sname]
            rows = list(sheet.iter_rows(values_only=True))
            start_idx = -1
            for idx, r in enumerate(rows):
                line_str = " ".join([str(c) for c in r if c is not None])
                if ("更新日" in line_str or "Date" in line_str) and ("内容" in line_str or "Description" in line_str or "Change" in line_str):
                    start_idx = idx + 1
                    break

            if start_idx != -1:
                for r in rows[start_idx:]:
                    vals = [clean_val(c) for c in r if c is not None]
                    if len(vals) >= 4 and vals[0] and vals[0].isdigit():
                        history.append({
                            "no": vals[0],
                            "date": str(vals[1]).split(" ")[0],
                            "author": vals[2],
                            "desc": vals[3]
                        })
                if history:
                    latest = history[-1]
                    latest_version = f"1.{len(history)}"
                    latest_author = latest["author"]
                    latest_change = latest["desc"]
                    latest_date = latest["date"]
            break

    # 2. Function overview / events
    functions = []
    for sname in ("機能概要", "Overview", "Functions"):
        if sname in sheet_names:
            sheet = wb[sname]
            rows = list(sheet.iter_rows(values_only=True))
            start_idx = -1
            for idx, r in enumerate(rows):
                line_str = " ".join([str(c) for c in r if c is not None])
                if "機能名" in line_str or "Function" in line_str:
                    start_idx = idx + 1
                    break

            if start_idx != -1:
                for r in rows[start_idx:]:
                    vals = [clean_val(c) for c in r if c is not None]
                    if len(vals) >= 3 and vals[0] and vals[0].isdigit():
                        f_table = vals[3] if len(vals) > 3 else "-"
                        functions.append({
                            "no": vals[0],
                            "name": vals[1],
                            "desc": vals[2],
                            "table": f_table
                        })
            break

    # 3. Validation / check rules
    validations = []
    for sname in ("チェック仕様", "Validation", "Checks"):
        if sname in sheet_names:
            sheet = wb[sname]
            rows = list(sheet.iter_rows(values_only=True))
            start_idx = -1
            for idx, r in enumerate(rows):
                line_str = " ".join([str(c) for c in r if c is not None])
                if "チェック仕様" in line_str or "Rule" in line_str or "Validation" in line_str:
                    start_idx = idx + 1
                    break

            if start_idx != -1:
                for r in rows[start_idx:]:
                    vals = [clean_val(c) for c in r if c is not None]
                    if len(vals) >= 3 and vals[0] and vals[0].isdigit():
                        v_type = vals[3] if len(vals) > 3 else "Error"
                        validations.append({
                            "no": vals[0],
                            "name": vals[1],
                            "desc": vals[2],
                            "type": v_type
                        })
            break

    wb.close()

    return {
        "id": spec_id,
        "title": title,
        "file_mtime": file_mtime,
        "latest_version": latest_version,
        "latest_author": latest_author,
        "latest_change": latest_change,
        "latest_date": latest_date,
        "history": history,
        "functions": functions,
        "validations": validations,
        "source_file": file_path,
    }


def render_spec_markdown(data, rel_source=None):
    """Render spec dictionary into standard Markdown with YAML frontmatter."""
    converted_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    src = rel_source or os.path.basename(data["source_file"])

    lines = [
        "---",
        f"id: \"{data['id']}\"",
        f"title: \"{data['title']}\"",
        f"version: \"{data['latest_version']}\"",
        f"last_updated: \"{data['latest_date']}\"",
        f"last_author: \"{data['latest_author']}\"",
        f"last_change: \"{data['latest_change']}\"",
        f"source_file: \"{src}\"",
        f"source_mtime: \"{data['file_mtime']}\"",
        f"converted_at: \"{converted_at}\"",
        "---",
        "",
        f"# [{data['id']}] {data['title']}",
        "",
        f"> **Source document:** `{src}`  ",
        f"> **Last modified:** `{data['file_mtime']}` · **Version:** `v{data['latest_version']}`  ",
        f"> **Converted at:** `{converted_at}`",
        "",
        "---",
        "",
        "## 1. Revision History (Changelog)",
        "",
        "| No | Date | Author | Change Description |",
        "|:---:|:---:|:---|:---|",
    ]

    if data["history"]:
        for h in data["history"]:
            lines.append(f"| {h['no']} | {h['date']} | {h['author']} | {h['desc']} |")
    else:
        lines.append(f"| 1 | {data['file_mtime']} | {data['latest_author'] or 'N/A'} | {data['latest_change']} |")

    lines.extend([
        "",
        "---",
        "",
        "## 2. Functions & Events (Overview)",
        "",
        "| No | Function Name | Description | Related Table / Entity |",
        "|:---:|:---|:---|:---|",
    ])

    if data["functions"]:
        for f in data["functions"]:
            lines.append(f"| {f['no']} | {f['name']} | {f['desc']} | `{f['table']}` |")
    else:
        lines.append("| - | - | Standard interface | - |")

    lines.extend([
        "",
        "---",
        "",
        "## 3. Validation & Business Rules",
        "",
        "| No | Rule Name | Condition & Expected Behavior | Type |",
        "|:---:|:---|:---|:---:|",
    ])

    if data["validations"]:
        for v in data["validations"]:
            lines.append(f"| {v['no']} | {v['name']} | {v['desc']} | `{v['type']}` |")
    else:
        lines.append("| - | - | Defined in form schema | - |")

    lines.append("")
    return "\n".join(lines)


def ingest_directory(source_dir, out_dir):
    """Scan and ingest all specification documents in a directory."""
    os.makedirs(out_dir, exist_ok=True)
    screens_dir = os.path.join(out_dir, "screens")
    os.makedirs(screens_dir, exist_ok=True)

    active_files = []
    for root, dirs, files in os.walk(source_dir):
        parts = root.split(os.sep)
        if any(p in ("[old]", "old", "bk", "BK", "対象外", "backup", "tmp") for p in parts):
            continue
        for f in files:
            if f.endswith(".xlsx") and not f.startswith("~$"):
                active_files.append(os.path.join(root, f))
            elif f.endswith(".md") and f not in ("README.md", "index.md"):
                # Also accept markdown specs
                pass

    if not active_files:
        print(f"No valid specification files found in {source_dir}")
        return 0

    index_entries = []
    count = 0

    for fpath in sorted(active_files):
        try:
            rel = os.path.relpath(fpath, source_dir)
            data = parse_xlsx_spec(fpath)
            md_text = render_spec_markdown(data, rel_source=rel)
            out_file = os.path.join(screens_dir, f"{data['id']}.md")

            with open(out_file, "w", encoding="utf-8") as fh:
                fh.write(md_text)

            index_entries.append({
                "id": data["id"],
                "title": data["title"],
                "category": os.path.dirname(rel) or "General",
                "file": f"screens/{data['id']}.md",
                "mtime": data["file_mtime"],
                "version": f"v{data['latest_version']}",
                "change": data["latest_change"]
            })
            count += 1
        except Exception as e:
            print(f"Warning: Failed to convert {os.path.basename(fpath)}: {e}", file=sys.stderr)

    # Master index README.md
    index_lines = [
        "# Specifications Master Index",
        "",
        "> **Purpose:** Master catalog of digitized specifications with version and changelog tracking.",
        f"> **Total Specs:** `{count}` · **Generated at:** `{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`",
        "",
        "---",
        "",
        "| Spec ID | Title | Category | Markdown File | Version | Source Modified | Latest Change |",
        "|:---|:---|:---|:---:|:---:|:---:|:---|",
    ]

    for it in index_entries:
        index_lines.append(f"| **`{it['id']}`** | {it['title']} | {it['category']} | [{it['id']}.md]({it['file']}) | `{it['version']}` | {it['mtime']} | {it['change']} |")

    index_path = os.path.join(out_dir, "README.md")
    with open(index_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(index_lines) + "\n")

    print(f"Successfully converted {count} specifications into {out_dir}")
    print(f"Master index generated at {index_path}")
    return count


def selftest():
    """Verify that specs_ingest functions properly."""
    tmp = tempfile.mkdtemp(prefix="aiqa-specs-test-")
    try:
        sample_data = {
            "id": "SC-DEMO-001",
            "title": "Order Placement",
            "file_mtime": "2026-09-22 10:00:00",
            "latest_version": "1.2",
            "latest_author": "Tester",
            "latest_change": "Added quantity check",
            "latest_date": "2026-09-22",
            "history": [
                {"no": "1", "date": "2026-09-01", "author": "Alice", "desc": "Initial draft"},
                {"no": "2", "date": "2026-09-22", "author": "Tester", "desc": "Added quantity check"},
            ],
            "functions": [
                {"no": "1", "name": "Place Order", "desc": "Submits cart to DB", "table": "orders"}
            ],
            "validations": [
                {"no": "1", "name": "Min Qty", "desc": "Quantity must be >= 1", "type": "Error"}
            ],
            "source_file": "/tmp/orders.xlsx"
        }
        md = render_spec_markdown(sample_data, rel_source="orders.xlsx")
        assert "SC-DEMO-001" in md, "Missing ID in markdown"
        assert "Added quantity check" in md, "Missing changelog description in markdown"
        assert "source_mtime: \"2026-09-22 10:00:00\"" in md, "Missing source_mtime in frontmatter"
        assert "converted_at:" in md, "Missing converted_at in frontmatter"
        print("specs_ingest selftest: PASS")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description="Ingest specifications into Git-tracked Markdown")
    parser.add_argument("--source", type=str, help="Source directory or file of specifications")
    parser.add_argument("--out", type=str, default="docs/specs", help="Target output directory (default: docs/specs)")
    parser.add_argument("--audit", action="store_true", help="Audit existing specs in docs/specs")
    parser.add_argument("--selftest", action="store_true", help="Run self-test")

    args = parser.parse_args()

    if args.selftest:
        return selftest()

    if args.source:
        ingest_directory(args.source, args.out)
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
