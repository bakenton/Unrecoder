"""Generates content/campaign/act1.json: the 10x10 matrix, label rings and three transmissions.

Run from the repository root:  python content/tools/generate_act1.py
Everything is seeded; the script verifies that every dump has exactly the intended key pairs
(no accidental ones) and is solvable by Likeness feedback within MAX_TRIES.
"""
import itertools
import json
import random
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "content" / "campaign" / "act1.json"
COLS, ROWS = 12, 8
MAX_TRIES = 5

ROW_RING = ["KO", "MI", "RA", "TU", "BE", "NO", "SA", "LI", "PE", "DU"]
COL_RING = ["ZA", "FY", "HO", "VE", "GI", "XU", "JA", "WE", "YO", "QI"]

# --- the matrix: contents are fixed for the whole game, only the labels move ---
EXPLICIT = {
    "18": ("who", "team"), "52": ("who", "leader"), "83": ("who", "member"),
    "29": ("place", "CP4"), "64": ("place", "CP3"), "07": ("place", "base"), "41": ("place", "CP2"),
    "75": ("action", "reached"), "33": ("action", "left"), "90": ("action", "stopped"), "16": ("action", "found"),
    "58": ("thing", "bridge"), "12": ("thing", "tent"), "47": ("thing", "rope"), "81": ("thing", "camp"),
    "26": ("state", "broken / repaired"), "69": ("state", "injured"), "04": ("state", "safe"), "95": ("state", "tired"),
    "50": ("marker", "number"), "23": ("marker", "spell"),
}
FILL = (
    [("who", w) for w in ["medic", "guide", "porter"]]
    + [("place", w) for w in ["CP1", "south ridge", "glacier", "ridge", "hut", "pass", "camp site", "cave", "river", "slope", "summit", "valley"]]
    + [("action", w) for w in ["crossed", "climbed", "waiting", "camped", "descending", "resting", "moving", "searching", "returning"]]
    + [("thing", w) for w in ["sample", "radio", "sled", "ice axe", "stove", "fuel", "food", "map", "boots", "gloves", "blanket", "flare", "compass", "tarp"]]
    + [("state", w) for w in ["snowing", "windy", "low battery", "lost", "cold", "hungry", "wet", "ready"]]
    + [("service", w) for w in ["over", "understood", "say again", "stand by", "out", "radio check", "no reply"]]
    + [("letter", c) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
)


def build_matrix(seed=7):
    r = random.Random(seed)
    free = [f"{i:02d}" for i in range(100) if f"{i:02d}" not in EXPLICIT]
    assert len(free) == len(FILL), (len(free), len(FILL))
    r.shuffle(FILL)
    cells = {}
    for cid, (kind, text) in EXPLICIT.items():
        cells[cid] = cell(kind, text)
    for cid, (kind, text) in zip(free, FILL):
        cells[cid] = cell(kind, text)
    return dict(sorted(cells.items()))


def cell(kind, text):
    meanings = [m.strip() for m in text.split("/")]
    return {"kind": kind, "text": text, "meanings": meanings}


MATRIX = build_matrix()
LETTER_ID = {c["text"]: cid for cid, c in MATRIX.items() if c["kind"] == "letter"}


def label_for(ring, start, digit):
    return ring[(ring.index(start) + digit) % 10]


def digit_of(ring, start, label):
    return (ring.index(label) - ring.index(start)) % 10


NEUTRAL = [a + b for a in "BCDFGHKLMNPRSTVWZ" for b in "AEIOU"]
NEUTRAL = [x for x in NEUTRAL if x not in ROW_RING and x not in COL_RING]
JUNK_POOL = NEUTRAL * 3 + ROW_RING + COL_RING  # ring labels as "false friends", never forming a pair


def pairs_in(dump, key):
    """All adjacent (row label, col label) pairs -> [(cell id, a, b)]."""
    out = []
    n = len(dump)
    for i in range(n):
        for j in (i + 1, i + COLS):
            if j >= n or (j == i + 1 and (i % COLS) == COLS - 1):
                continue
            a, b = dump[i], dump[j]
            for x, y in ((a, b), (b, a)):
                if x in ROW_RING and y in COL_RING:
                    cid = f"{digit_of(ROW_RING, key['row'], x)}{digit_of(COL_RING, key['col'], y)}"
                    out.append((cid, i, j))
                    break
    return out


def build_dump(seed, key, tokens):
    """tokens: list of cell ids in intended reading order. Returns (dump, {id: (a, b)}) or None."""
    r = random.Random(seed)
    n = COLS * ROWS
    grid = [None] * n
    place = {}
    anchors = sorted(r.sample(range(n), len(tokens)))
    for cid, a in zip(tokens, anchors):
        opts = []
        if a % COLS < COLS - 1:
            opts.append(a + 1)
        if a + COLS < n:
            opts.append(a + COLS)
        if not opts:
            return None
        b = r.choice(opts)
        if grid[a] is not None or grid[b] is not None or b in anchors:
            return None
        row_label = label_for(ROW_RING, key["row"], int(cid[0]))
        col_label = label_for(COL_RING, key["col"], int(cid[1]))
        pair = [row_label, col_label]
        if r.random() < 0.5:
            pair.reverse()
        grid[a], grid[b] = pair
        place[cid] = (a, b)
    for i in range(n):
        if grid[i] is None:
            grid[i] = r.choice(JUNK_POOL)
    return grid, place


def next_after(sorted_occ, pick):
    for o in sorted_occ:
        if min(o[1], o[2]) > min(pick[1], pick[2]):
            return o
    return None


def combos_for(slots, occ_sorted, kinds_of):
    """All parseable picks (lists of (id, a, b)) under the engine's rules."""
    out = []

    def rec(i, chosen):
        if i == len(slots):
            out.append(tuple(chosen))
            return
        if slots[i] in ("number", "letter") and i > 0:
            nxt = next_after(occ_sorted, chosen[-1])
            cands = [nxt] if nxt else []
            if slots[i] == "letter":
                cands = [c for c in cands if MATRIX[c[0]]["kind"] == "letter"]
        else:
            cands = [o for o in occ_sorted if MATRIX[o[0]]["kind"] == slots[i]]
        for c in cands:
            if chosen and min(chosen[-1][1], chosen[-1][2]) >= min(c[1], c[2]):
                continue
            rec(i + 1, chosen + [c])

    rec(0, [])
    return out


def worst_case_tries(combos):
    def lk(p, q):
        return sum(1 for x, y in zip(p, q) if x[0] == y[0] and {x[1], x[2]} == {y[1], y[2]})

    @lru_cache(None)
    def solve(pool):
        if len(pool) == 1:
            return 1
        best = 99
        for g in pool:
            groups = {}
            for c in pool:
                groups.setdefault(lk(g, c), []).append(c)
            worst = max([solve(tuple(v)) for k, v in groups.items() if k != len(g)] or [0])
            best = min(best, 1 + worst)
        return best

    return solve(tuple(combos))


def make_transmission(spec):
    key = spec["key"]
    for seed in range(spec.get("seedStart", 1), spec.get("seedStart", 1) + 300000):
        res = build_dump(seed, key, spec["tokens"])
        if not res:
            continue
        dump, place = res
        occ = sorted(pairs_in(dump, key), key=lambda o: min(o[1], o[2]))
        if sorted((c, a, b) for c, a, b in occ) != sorted((c, *place[c]) for c in spec["tokens"]):
            continue
        # intended order must equal reading order
        if [o[0] for o in occ] != spec["tokens"]:
            continue
        combos = combos_for(spec["slots"], occ, None)
        real = tuple((c, *place[c]) for c in spec["cipher"])
        if real not in combos:
            continue
        n = worst_case_tries(combos)
        if n <= MAX_TRIES:
            tx = {k: v for k, v in spec.items() if k not in ("tokens", "key", "seedStart")}
            tx.update({
                "indicator": {"row": key["row"], "col": key["col"]},
                "keyHelp": spec["keyHelp"],
                "cols": COLS,
                "dump": dump,
                "cells": [list(place[c]) for c in spec["cipher"]],
            })
            print(f"{spec['id']}: seed {seed}, {len(combos)} parses, worst case {n} tries", file=sys.stderr)
            return tx
    raise SystemExit(f"no valid dump for {spec['id']}")


SPECS = [
    {
        "id": "T01-bridge", "time": "14:32", "keyHelp": True,
        "key": {"row": "RA", "col": "HO"},
        "slots": ["who", "place", "action", "thing", "state"],
        "tokens": ["52", "18", "64", "33", "29", "75", "58", "12", "69", "26"],
        "cipher": ["18", "29", "75", "58", "26"],
        "clauses": [{"pattern": "The {0} {2} {1}."}, {"pattern": "The {3} is {4}."}],
        "truth": {"4": "broken"},
        "hint": "No one on the team can repair the bridge now: the only repair tech (04) is injured and stayed at CP3. So the bridge can only be broken.",
        "outcomes": {
            "continue": {"severity": "harm", "text": "The bridge collapsed. One member injured.",
                         "crew": [{"id": "06", "status": "injured", "note": "injured in the bridge collapse"}],
                         "nearMiss": "We stopped at the bridge. Something felt wrong. No one crossed."},
            "wait": {"severity": "safe", "text": "All safe. Looking for another route.", "crew": []},
            "back": {"severity": "delay", "text": "Back at CP3. We lost half a day, but everyone is safe.", "crew": []},
            "hurry": {"severity": "harm", "text": "We rushed the crossing. The bridge gave way. Two members injured.",
                      "crew": [{"id": "06", "status": "injured", "note": "injured in the bridge collapse"},
                               {"id": "08", "status": "injured", "note": "injured in the bridge collapse"}],
                      "nearMiss": "We started to rush, then stopped at the edge. No one hurt."},
            "base": {"severity": "delay", "text": "Returning to base. The route is abandoned for now.", "crew": []},
        },
    },
    {
        "id": "T02-member", "time": "15:41", "keyHelp": False, "seedStart": 5000,
        "key": {"row": "BE", "col": "JA"},
        "slots": ["who", "marker", "number", "state", "place"],
        # decoy "spell" marker is followed by decoy number 03; the real marker "number" by 06
        "tokens": ["52", "83", "23", "03", "50", "06", "04", "69", "07", "29"],
        "cipher": ["83", "50", "06", "69", "29"],
        "clauses": [{"pattern": "The {0} {2} is {3} at {4}."}],
        "truth": {},
        "hint": "A number in the message is a crew ID: 06 is a climber. After a number marker, the next pair in the noise is the number itself.",
        "outcomes": {
            "continue": {"severity": "harm", "text": "We pushed on. 06 is getting worse. We have to stop.",
                         "crew": [{"id": "06", "status": "injured", "note": "injured, worsening"}],
                         "nearMiss": "We started to move, then stopped. 06 is being treated."},
            "wait": {"severity": "safe", "text": "Medic is with 06. Stable. We rest here.",
                     "crew": [{"id": "06", "status": "injured", "note": "injured, stable at CP4"}]},
            "back": {"severity": "delay", "text": "Carrying 06 back to CP3. It is slow.",
                     "crew": [{"id": "06", "status": "injured", "note": "being carried back"}]},
            "hurry": {"severity": "harm", "text": "Hurrying with an injured man. 06 fell. It is bad.",
                      "crew": [{"id": "06", "status": "injured", "note": "injured, serious"}],
                      "nearMiss": "We almost hurried. We slowed down for 06."},
            "base": {"severity": "delay", "text": "Evacuating 06 to base. The team is following.",
                     "crew": [{"id": "06", "status": "injured", "note": "evacuating to base"}]},
        },
    },
    {
        "id": "T03-hut", "time": "17:05", "keyHelp": False, "seedStart": 9000,
        "key": {"row": "SA", "col": "WE"},
        "slots": ["who", "action", "marker", "letter", "letter", "letter"],
        "tokens": ["52", "18", "33", "16", "50", LETTER_ID["K"], LETTER_ID["E"], LETTER_ID["S"], "23", LETTER_ID["H"], LETTER_ID["U"], LETTER_ID["T"]],
        "cipher": ["18", "16", "23", LETTER_ID["H"], LETTER_ID["U"], LETTER_ID["T"]],
        "clauses": [{"pattern": "The {0} {1}: {3}{4}{5}."}],
        "truth": {},
        "hint": "After the spell marker, letters follow one by one. Only one of the two spelled words makes sense for a team in the mountains.",
        "outcomes": {
            "continue": {"severity": "harm", "text": "We went past the hut. The weather turned. One frostbitten.",
                         "crew": [{"id": "07", "status": "injured", "note": "frostbite"}],
                         "nearMiss": "We almost went past the hut. We turned back and sheltered."},
            "wait": {"severity": "safe", "text": "We are in the hut. Warm. Waiting out the weather.", "crew": []},
            "back": {"severity": "delay", "text": "Back toward CP3. We will lose the hut.", "crew": []},
            "hurry": {"severity": "harm", "text": "We hurried past the hut into the storm. Two frostbitten.",
                      "crew": [{"id": "07", "status": "injured", "note": "frostbite"}, {"id": "09", "status": "injured", "note": "frostbite"}],
                      "nearMiss": "We almost hurried on. We stopped at the hut instead."},
            "base": {"severity": "delay", "text": "Returning to base. We leave the hut behind.", "crew": []},
        },
    },
]


def main():
    prev = json.loads(OUT.read_text(encoding="utf-8"))
    act = {
        "crew": prev["crew"],
        "map": prev["map"],
        "rings": {"rows": ROW_RING, "cols": COL_RING},
        "matrix": {"rows": 10, "cols": 10, "cells": MATRIX},
        "transmissions": [make_transmission(s) for s in SPECS],
    }
    OUT.write_text(json.dumps(act, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
