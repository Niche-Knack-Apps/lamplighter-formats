#!/usr/bin/env python3
"""Compile all schemas and verify positive/negative resource fixtures."""
import copy
import json
from pathlib import Path
from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parent.parent


def main():
    checked = 0
    for kind in ["edition", "commentary", "cross-references", "original-language", "lexicon"]:
        schema = json.loads((ROOT / "schemas" / f"{kind}.schema.json").read_text())
        Draft7Validator.check_schema(schema)
        validator = Draft7Validator(schema)
        sample = json.loads((ROOT / "templates" / f"{kind}.sample.json").read_text())
        validator.validate(sample)
        invalid = copy.deepcopy(sample)
        invalid["formatVersion"] = 2
        assert not validator.is_valid(invalid), kind
        invalid = copy.deepcopy(sample)
        if kind == "edition":
            invalid["books"][0]["chapters"][0]["verses"][0]["text"] = 123
        elif kind == "commentary":
            invalid["entries"][0]["range"]["start"] = {"book_index": 0, "verse": 1}
        elif kind == "cross-references":
            invalid["refs"]["0.0.0"] = [{"ref": "0.1.1"}]
        elif kind == "original-language":
            invalid["verses"]["0.1.1"][0]["wordIndex"] = -1
        else:
            invalid["entries"]["H1697"]["def"] = None
        assert not validator.is_valid(invalid), kind
        checked += 1
    checked += check_pack()
    print(f"{checked} Draft-07 schemas compiled; templates and invalid fixtures checked.")


def check_pack():
    """The pack manifest and its parts; a part's entries are exactly a commentary's entries."""
    load = lambda name: json.loads((ROOT / "schemas" / f"{name}.schema.json").read_text())
    commentary, pack, part = load("commentary"), load("commentary-pack"), load("commentary-part")
    assert part["properties"]["entries"] == commentary["properties"]["entries"], "part entries drifted from commentary entries"
    point = commentary["properties"]["entries"]["items"]["properties"]["range"]["properties"]["start"]
    assert all(pack["properties"]["parts"]["items"]["properties"]["range"]["properties"][k] == point for k in ("start", "end"))
    for schema in (pack, part):
        Draft7Validator.check_schema(schema)
    folder = ROOT / "templates" / "commentary-pack.sample"
    manifest = json.loads((folder / "pack.json").read_text())
    Draft7Validator(pack).validate(manifest)
    for listed in manifest["parts"]:
        Draft7Validator(part).validate(json.loads((folder / listed["file"]).read_text()))
    for change in (lambda m: m.update(formatVersion=2), lambda m: m.update(type="commentary"),
                   lambda m: m["parts"][0].update(file="../escape.json"), lambda m: m["parts"][0].update(file="pack.json"),
                   lambda m: m["parts"][0]["range"].pop("end"), lambda m: m["parts"][0].update(sha256="ABC")):
        invalid = copy.deepcopy(manifest)
        change(invalid)
        assert not Draft7Validator(pack).is_valid(invalid), invalid
    sample = json.loads((folder / manifest["parts"][0]["file"]).read_text())
    for change in (lambda d: d.pop("formatVersion"), lambda d: d.update(entries=[]),
                   lambda d: d["entries"][0]["range"].update(start={"book_index": 0, "verse": 1})):
        invalid = copy.deepcopy(sample)
        change(invalid)
        assert not Draft7Validator(part).is_valid(invalid), invalid
    return 2


if __name__ == "__main__":
    main()
