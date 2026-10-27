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
    """A pack's metadata, index and parts. The metadata takes a commentary's own fields, and a
    part's entries are exactly a commentary's entries."""
    load = lambda name: json.loads((ROOT / "schemas" / f"{name}.schema.json").read_text())
    commentary, metadata, index, part = (load(n) for n in ("commentary", "commentary-pack", "commentary-index", "commentary-part"))
    assert part["properties"]["entries"] == commentary["properties"]["entries"], "part entries drifted from commentary entries"
    for key, value in commentary["properties"].items():
        if key not in ("entries", "type", "formatVersion"):
            assert metadata["properties"][key] == value, f"metadata field {key} drifted from commentary"
    for schema in (metadata, index, part):
        Draft7Validator.check_schema(schema)
    folder = ROOT / "templates" / "commentary-pack.sample"
    read = lambda name: json.loads((folder / name).read_text())
    meta, idx = read("_metadata.json"), read("_index.json")
    Draft7Validator(metadata).validate(meta)
    Draft7Validator(index).validate(idx)
    for listed in idx["parts"]:
        Draft7Validator(part).validate(read(listed["file"]))
    for change in (lambda m: m.update(formatVersion=2), lambda m: m.update(type="commentary"),
                   lambda m: m.pop("entryCount"), lambda m: m.update(entries=[])):
        invalid = copy.deepcopy(meta)
        change(invalid)
        assert not Draft7Validator(metadata).is_valid(invalid), invalid
    for change in (lambda i: i.update(type="commentary-pack"), lambda i: i["parts"][0].update(file="../escape.json"),
                   lambda i: i["parts"][0].update(file="_index.json"), lambda i: i["parts"][0].update(sha256="ABC"),
                   lambda i: i["books"].update({"x": {"chapters": {}}}), lambda i: i["books"]["42"]["chapters"].update({"0": [1]}),
                   lambda i: i["books"]["42"]["chapters"].update({"2": [[1, 0]]}), lambda i: i["books"]["42"]["chapters"].update({"2": [[1, 2, 3, 4]]}),
                   lambda i: i["books"]["42"]["chapters"].update({"2": []})):
        invalid = copy.deepcopy(idx)
        change(invalid)
        assert not Draft7Validator(index).is_valid(invalid), invalid
    sample = read(idx["parts"][0]["file"])
    for change in (lambda d: d.pop("formatVersion"), lambda d: d.update(entries=[]),
                   lambda d: d["entries"][0]["range"].update(start={"book_index": 0, "verse": 1})):
        invalid = copy.deepcopy(sample)
        change(invalid)
        assert not Draft7Validator(part).is_valid(invalid), invalid
    return 3


if __name__ == "__main__":
    main()
