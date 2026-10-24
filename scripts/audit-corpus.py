#!/usr/bin/env python3
"""Read-only corpus validation; receipts include counts/hashes, never resource text."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("converter", ROOT / "scripts/convert.py")
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


def audit(file):
    raw = converter.read_bytes(file)
    data = converter.load_json(raw)
    report = converter.Report()
    kind = "edition" if "books" in data else "commentary" if isinstance(data.get("entries"), list) else "cross-references" if "refs" in data else "original-language" if "verses" in data else "lexicon"
    normalized = converter.normalize_json(data, report) if kind == "edition" else data
    preserved = 0
    if kind == "edition":
        for bpos, book in enumerate(data["books"]):
            for cpos, chapter in enumerate(book["chapters"], 1):
                c = chapter.get("chapter", cpos)
                for vpos, verse in enumerate(chapter["verses"], 1):
                    v = verse.get("verse", vpos)
                    actual = normalized["books"][bpos]["chapters"][c - 1]["verses"][v - 1]
                    assert actual == {**verse, "verse": v}, "Normalization changed a supplied verse object"
                    preserved += 1
    schema = json.loads((ROOT / "schemas" / f"{kind}.schema.json").read_text())
    Draft7Validator.check_schema(schema)
    validator = Draft7Validator(schema)
    schema_errors = [{"path": list(e.path), "validator": e.validator} for e in validator.iter_errors(normalized)]
    script = "const fs=require('fs');const r=require(process.argv[1]).lint(JSON.parse(fs.readFileSync(0,'utf8')));console.log(JSON.stringify({errors:r.errors.length,warnings:r.warnings.length,info:r.info}));"
    result = subprocess.run(["node", "-e", script, str(ROOT / "lib/validate.js")], input=json.dumps(normalized), capture_output=True, text=True, check=True, timeout=120)
    checks = json.loads(result.stdout)
    return {"file": file.name, "sourceSha256": hashlib.sha256(raw).hexdigest(), "kind": kind, "suppliedVerseObjectsPreserved": preserved, "schemaErrors": schema_errors, "semanticErrors": checks["errors"], "warnings": checks["warnings"], "info": checks["info"], "normalization": list(report.events.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    options = parser.parse_args()
    rows = []
    for file in sorted(options.directory.rglob("*.json")):
        row = audit(file)
        rows.append(row)
        print(f"{file.name}: {len(row['schemaErrors'])} schema errors, {row['semanticErrors']} semantic errors", flush=True)
    if not rows:
        raise SystemExit("No JSON resources found.")
    passed = all(not row["schemaErrors"] and row["semanticErrors"] == 0 for row in rows)
    receipt = {"passed": passed, "files": len(rows), "suppliedVerseObjectsPreserved": sum(row["suppliedVerseObjectsPreserved"] for row in rows), "sourceFilesChanged": False, "scope": "Schemas and semantic validation after explicit in-memory edition normalization; original source files remain unchanged.", "resources": rows}
    options.out.parent.mkdir(parents=True, exist_ok=True)
    options.out.write_text(json.dumps(receipt, indent=2) + "\n")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
