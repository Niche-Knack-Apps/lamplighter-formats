#!/usr/bin/env python3
"""Compile all schemas and verify positive/negative resource fixtures."""
import copy
import json
from pathlib import Path
from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parent.parent


def main():
    checked = 0
    for kind in ["edition", "commentary", "cross-references", "original-language", "lexicon", "word-links", "renderings", "morph-codes"]:
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
            invalid["verses"]["0.1.1"][0]["glossOrder"] = -1
            compact = copy.deepcopy(sample)
            compact["wordFields"] = ["word", "strongs", "gloss"]
            compact["verses"]["0.1.1"] = [["דָּבָר", "H1697", "The word"], ["הָיָה", "H1961"]]
            validator.validate(compact)
        elif kind == "word-links":
            invalid["verses"]["0.1.1"][0][1] = "H1697,H1961"
        elif kind == "renderings":
            invalid["renderings"]["H1697"]["word"] = 0
        elif kind == "morph-codes":
            invalid["codes"]["N-ms"] = ""
        else:
            invalid["entries"]["H1697"]["def"] = None
        assert not validator.is_valid(invalid), kind
        checked += 1
    print(f"{checked} Draft-07 schemas compiled; templates and invalid fixtures checked.")


if __name__ == "__main__":
    main()
