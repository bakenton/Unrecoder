"""Generates content/campaign/act1.json: the 10x10 matrix and three transmissions.

Run from the repository root:  python content/tools/generate_act1.py

Matrix: row digits 0-9, column letters a-j. A key in the noise is a digit touching a letter a-j
(side by side or stacked, either order); together they name a cell such as "7c".
Every dump is verified to contain exactly the intended keys (no accidental ones) and to be
solvable by Likeness feedback within MAX_TRIES. Everything is seeded.
"""
import json
import random
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "content" / "campaign" / "act1.json"
COLS, ROWS = 12, 8
MAX_TRIES = 5
COL_LETTERS = "abcdefghij"
DIGITS = "0123456789"


def cid(old):
    """'18' (row 1, column 8) -> '1i'."""
    return old[0] + COL_LETTERS[int(old[1])]


# --- the matrix: contents are fixed for the whole game ---
EXPLICIT = {cid(k): v for k, v in {
    "18": ("who", "team"), "52": ("who", "leader"), "83": ("who", "member"),
    "29": ("place", "CP4"), "64": ("place", "CP3"), "07": ("place", "base"), "41": ("place", "CP2"),
    "75": ("action", "reached"), "33": ("action", "left"), "90": ("action", "stopped"), "16": ("action", "found"),
    "58": ("thing", "bridge"), "12": ("thing", "tent"), "47": ("thing", "rope"), "81": ("thing", "camp"),
    "26": ("state", "broken / repaired"), "69": ("state", "injured"), "04": ("state", "safe"), "95": ("state", "tired"),
    "50": ("marker", "number"), "23": ("marker", "spell"),
}.items()}
FILL = (
    [("who", w) for w in ["medic", "guide", "porter"]]
    + [("place", w) for w in ["CP1", "south ridge", "glacier", "ridge", "hut", "pass", "camp site", "cave", "river", "slope", "summit", "valley"]]
    + [("action", w) for w in ["crossed", "climbed", "waiting", "camped", "descending", "resting", "moving", "searching", "returning"]]
    + [("thing", w) for w in ["sample", "radio", "sled", "ice axe", "stove", "fuel", "food", "map", "boots", "gloves", "blanket", "flare", "compass", "tarp"]]
    + [("state", w) for w in ["snowing", "windy", "low battery", "lost", "cold", "hungry", "wet", "ready"]]
    + [("service", w) for w in ["over", "understood", "say again", "stand by", "out", "radio check", "no reply"]]
    + [("letter", c) for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
)


def cell(kind, text):
    return {"kind": kind, "text": text, "meanings": [m.strip() for m in text.split("/")]}


def build_matrix(seed=7):
    r = random.Random(seed)
    all_ids = [d + c for d in DIGITS for c in COL_LETTERS]
    free = [i for i in all_ids if i not in EXPLICIT]
    assert len(free) == len(FILL), (len(free), len(FILL))
    fill = FILL[:]
    r.shuffle(fill)
    cells = {i: cell(*EXPLICIT[i]) for i in EXPLICIT}
    cells.update({i: cell(*f) for i, f in zip(free, fill)})
    return dict(sorted(cells.items()))


MATRIX = build_matrix()
LETTER_ID = {c["text"]: i for i, c in MATRIX.items() if c["kind"] == "letter"}


def is_key_pair(x, y):
    """Returns the cell id if x, y are a row digit and a column letter (either order)."""
    for d, l in ((x, y), (y, x)):
        if d in DIGITS and l in COL_LETTERS:
            return d + l
    return None


def pairs_in(dump):
    out = []
    n = len(dump)
    for i in range(n):
        for j in (i + 1, i + COLS):
            if j >= n or (j == i + 1 and i % COLS == COLS - 1):
                continue
            k = is_key_pair(dump[i], dump[j])
            if k:
                out.append((k, i, j))
    return out


NOISE_LETTERS = "klmnopqrstuvwxyz"


def build_dump(seed, tokens, friends):
    """tokens: cell ids in intended reading order. `friends` = chance a junk cell is a column letter a-j."""
    r = random.Random(seed)
    n = COLS * ROWS
    grid = [None] * n
    place = {}
    anchors = sorted(r.sample(range(n), len(tokens)))
    for t, a in zip(tokens, anchors):
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
        pair = [t[0], t[1]]
        if r.random() < 0.5:
            pair.reverse()
        grid[a], grid[b] = pair
        place[t] = (a, b)
    def neighbours(i):
        out = []
        if i % COLS > 0:
            out.append(i - 1)
        if i % COLS < COLS - 1:
            out.append(i + 1)
        if i - COLS >= 0:
            out.append(i - COLS)
        if i + COLS < n:
            out.append(i + COLS)
        return out

    def draw():
        roll = r.random()
        if roll < friends:
            return r.choice(COL_LETTERS)
        if roll < friends + 0.45:
            return r.choice(DIGITS)
        return r.choice(NOISE_LETTERS)

    # Fill the noise cell by cell, never completing an accidental key with an already filled neighbour.
    # Letters k-z are always safe, so this cannot dead-end.
    for i in range(n):
        if grid[i] is None:
            for _ in range(20):
                c = draw()
                if not any(grid[j] is not None and is_key_pair(c, grid[j]) for j in neighbours(i)):
                    break
            else:
                c = r.choice(NOISE_LETTERS)
            grid[i] = c
    return grid, place


def minc(o):
    return min(o[1], o[2])


def combos_for(slots, occ):
    out = []

    def rec(i, chosen):
        if i == len(slots):
            out.append(tuple(chosen))
            return
        if slots[i] in ("number", "letter") and i > 0:
            nxt = next((o for o in occ if minc(o) > minc(chosen[-1])), None)
            cands = [nxt] if nxt else []
            if slots[i] == "letter":
                cands = [c for c in cands if MATRIX[c[0]]["kind"] == "letter"]
        else:
            cands = [o for o in occ if MATRIX[o[0]]["kind"] == slots[i]]
        for c in cands:
            if chosen and minc(chosen[-1]) >= minc(c):
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
    seed0 = spec.get("seedStart", 1)
    for seed in range(seed0, seed0 + 300000):
        res = build_dump(seed, spec["tokens"], spec["friends"])
        if not res:
            continue
        dump, place = res
        occ = sorted(pairs_in(dump), key=minc)
        if [o[0] for o in occ] != spec["tokens"]:
            continue
        if sorted((c, a, b) for c, a, b in occ) != sorted((c, *place[c]) for c in spec["tokens"]):
            continue
        combos = combos_for(spec["slots"], occ)
        real = tuple((c, *place[c]) for c in spec["cipher"])
        if real not in combos:
            continue
        n = worst_case_tries(combos)
        if n <= MAX_TRIES:
            tx = {k: v for k, v in spec.items() if k not in ("tokens", "seedStart", "friends")}
            tx.update({"cols": COLS, "dump": dump, "cells": [list(place[c]) for c in spec["cipher"]]})
            print(f"{spec['id']}: seed {seed}, {len(combos)} parses, worst case {n} tries", file=sys.stderr)
            return tx
    raise SystemExit(f"no valid dump for {spec['id']}")


SPECS = [
    {
        "id": "T01-bridge", "time": "14:32", "friends": 0.05,
        "slots": ["who", "place", "action", "thing", "state"],
        # no decoys in the first message: just find the five keys and read them
        "tokens": [cid(x) for x in ["18", "29", "75", "58", "26"]],
        "cipher": [cid(x) for x in ["18", "29", "75", "58", "26"]],
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
        "id": "T02-member", "time": "15:41", "friends": 0.10, "seedStart": 5000,
        "slots": ["who", "marker", "number", "state", "place"],
        # decoys: leader (who), safe (state), base (place)
        "tokens": [cid(x) for x in ["52", "83", "50", "06", "04", "69", "07", "29"]],
        "cipher": [cid(x) for x in ["83", "50", "06", "69", "29"]],
        "clauses": [{"pattern": "The {0} {2} is {3} at {4}."}],
        "truth": {},
        "hint": "The number marker says the next pair is a number: 06 is a crew ID (a climber). The decoys are other phrases that would also fit, so use the Likeness count.",
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
        "id": "T03-hut", "time": "17:05", "friends": 0.12, "seedStart": 9000,
        "slots": ["who", "action", "marker", "letter", "letter", "letter"],
        # decoys: leader (who), and a second spelling KES after a "number" marker
        "tokens": [cid("52"), cid("18"), cid("16"), cid("50"), LETTER_ID["K"], LETTER_ID["E"], LETTER_ID["S"], cid("23"), LETTER_ID["H"], LETTER_ID["U"], LETTER_ID["T"]],
        "cipher": [cid("18"), cid("16"), cid("23"), LETTER_ID["H"], LETTER_ID["U"], LETTER_ID["T"]],
        "clauses": [{"pattern": "The {0} {1}: {3}{4}{5}."}],
        "truth": {},
        "hint": "After the spell marker the letters follow one by one. The other spelling follows a number marker, so it is not a spelled word.",
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
        "matrix": {"rows": DIGITS, "cols": COL_LETTERS, "cells": MATRIX},
        "transmissions": [make_transmission(s) for s in SPECS],
    }
    OUT.write_text(json.dumps(act, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
