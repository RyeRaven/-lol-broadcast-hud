#!/usr/bin/env python3
"""Rebuild of corpus_statblocks.py (lost): extract per-player stat payloads from corpus pkl.

Envelope (16.22 truth game, measured):
  t=0  header: ... [id3] 21 00 00 00 00 | len(u32) | op(u16) | const5 | payload
  t>0  header: ... [id3] a1 00        | len(u32) | op(u16) | const5 | payload
The per-message varying bytes sit around [m-8, m-1) and identity is NOT stable across
keyframes, so pid is assigned by appearance order within a keyframe (validated by
validate_order.py against dec_check truth). Dedup: per keyframe time keep the entry
with the most anchor hits.

Anchor = pack("<I",payloadLen)+pack("<H",opcode); payload at m+11, one per participant.

Output: <out>/<gameId>.jsonl lines {"t","pid1","order","id","payload"}
"""
import argparse, collections, io, json, os, pickle, struct

OP_LEN_TABLE = {  # version prefix -> (opcode, payloadLen); from corpus/README.md
    "14.20": (0x9F, 935), "15.6": (0x365, 1031), "15.10": (0x357, 1099),
    "15.20": (0x35F, 1203), "15.21": (0x248, 1211), "16.12": (0x47D, 1471),
    "16.21": (0x10B, 1263), "16.22": (0xDD, 1263),
}

def op_len_for(meta, detected=None):
    if detected and detected.get("statOpcode"):
        return int(detected["statOpcode"], 16), detected["payloadLen"]
    ver = meta["version"]
    for pref, v in sorted(OP_LEN_TABLE.items(), key=lambda kv: -len(kv[0])):
        if ver.startswith(pref):
            return v
    raise SystemExit("no opcode table entry for version " + ver)

def extract_game(pkl_path, op, P):
    with open(pkl_path, "rb") as f:
        blocks = pickle.load(f)
    anchor = struct.pack("<I", P) + struct.pack("<H", op)
    per_t = collections.defaultdict(list)
    for cid, slot, t, data in blocks:
        if not data or data[0] != 0x01:
            continue
        start = 0
        hits = []
        while True:
            m = data.find(anchor, start)
            if m < 0:
                break
            if m + 11 + P <= len(data):
                hits.append((data[m - 8:m - 1].hex(), data[m + 11:m + 11 + P]))
            start = m + 1
        if hits:
            per_t[t].append(hits)
    out = {}
    for t, groups in per_t.items():
        best = max(groups, key=len)
        for i, (ident, pay) in enumerate(best):
            out[(t, i)] = (ident, pay)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=r"C:/Temp/obs4/corpus")
    ap.add_argument("--out", default=r"C:/Temp/obs4/statblocks")
    ap.add_argument("--game", default="all")
    args = ap.parse_args()
    with io.open(os.path.join(args.corpus, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)
    os.makedirs(args.out, exist_ok=True)
    gids = sorted(idx["games"]) if args.game == "all" else [args.game]
    report = {}
    for gid in gids:
        meta = idx["games"][gid]
        det = (idx.get("statBlockDetection") or {}).get(gid)
        op, P = op_len_for(meta, det)
        found = extract_game(os.path.join(args.corpus, gid + ".pkl"), op, P)
        times = sorted(set(k[0] for k in found))
        maxn = max((i for (_, i) in found), default=-1) + 1
        n = 0
        with io.open(os.path.join(args.out, gid + ".jsonl"), "w", encoding="utf-8") as f:
            for (t, i) in sorted(found.keys(), key=lambda k: (k[0], k[1])):
                ident, pay = found[(t, i)]
                f.write(json.dumps({"t": round(t, 3), "pid1": i + 1, "order": i,
                                    "id": ident, "payload": pay.hex()}) + "\n")
                n += 1
        padc = collections.Counter()
        for (_, _i), (ident, pay) in list(found.items())[:40]:
            padc.update(pay[0::2])
        pad = padc.most_common(1)[0]
        report[gid] = {"op": hex(op), "len": P, "blocks": n, "times": len(times),
                       "perKf": maxn, "pad": hex(pad[0])}
    print(json.dumps(report, indent=1))

if __name__ == "__main__":
    main()
