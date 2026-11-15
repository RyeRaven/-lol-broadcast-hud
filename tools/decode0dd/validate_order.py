#!/usr/bin/env python3
"""Validate appearance-order pid hypothesis: KDA slots (155=kills,163=deaths,171=assists,
16.22) codepoints across blocks must map conflict-free to dec_check truth series."""
import io, json, collections
GID = "NJ100-901131919780"
rows = [json.loads(l) for l in io.open(f"C:/Temp/obs4/statblocks/{GID}.jsonl", encoding="utf-8")]
by_t = collections.defaultdict(dict)
for r in rows:
    by_t[r["t"]][r["order"]] = bytes.fromhex(r["payload"])
times = sorted(by_t)
print("times:", len(times), "per kf:", set(len(v) for v in by_t.values()))
chk = json.load(io.open(r"C:/Temp/obs4/dec_check.json", encoding="utf-8"))
truth_k = chk["series"]["kills"]; truth_d = chk["series"]["deaths"]; truth_a = chk["series"]["assists"]
SLOT = {"kills": 155, "deaths": 163, "assists": 171}
cp2val = {}
conflicts = 0
for fi, t in enumerate(times):
    for i in range(10):
        pay = by_t[t][i]
        for name, slot, truth in (("kills", SLOT["kills"], truth_k), ("deaths", SLOT["deaths"], truth_d), ("assists", SLOT["assists"], truth_a)):
            tv = truth[fi][i]
            if tv is None: continue
            cp = pay[slot]
            if cp in cp2val and cp2val[cp] != tv:
                conflicts += 1
            cp2val.setdefault(cp, tv)
print("codepoints seen:", len(cp2val), "conflicts:", conflicts)
print("cp->val:", dict(sorted(cp2val.items())))
# 逆映射检查（同值多码点=冲突）
v2c = collections.defaultdict(set)
for c, v in cp2val.items(): v2c[v].add(c)
print("values with >1 cp:", {v: sorted(c) for v, cs in v2c.items() for c in [cs] if len(cs) > 1})
