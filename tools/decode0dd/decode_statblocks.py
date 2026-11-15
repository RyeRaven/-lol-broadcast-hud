#!/usr/bin/env python3
"""Rebuild of decode_0xdd.py (lost): decode per-player stat blocks from corpus statblocks.

Empirical method (validated on the truth game NJ100-901131919780, timeline truth from
dec_check.json):
- f32 lanes (minionsKilled 119, jungleMinionsKilled 127, xp 79, totalGold 111) take 4
  codepoints at stride 2 -> 4 S-box bytes -> little-endian float. The pad codepoint
  encodes byte 0 ("padMapped").
- KEY MODEL (v9): the codepoint->byte mapping is NOT global. It is per payload-offset
  residue: byte = M[offset % 64][cp]. Verified empirically: votes keyed by offset % 64
  are conflict-free across 1000+ (offset, cp) pairs from minions/jungle lanes and the
  kills/deaths/assists u8 slots, while smaller periods (8/16/32/48) all show conflicts
  (structural b0=0 votes vs u8 semantic values at offsets 32 apart). Lanes are 8 bytes
  apart, so 8 consecutive lanes share one 64-byte table cycle; xp (79) and totalGold
  (111) residues {15,17,19,21}/{47,49,51,53} never overlap any voted lane residue, which
  is why a global sbox poisoned the cascade.
- xp/totalGold (v12): plain IEEE f32 - the exponent field naturally splits across
  byte3 (high 7 bits, b3 = E8>>1) and byte2's top bit (E8&1), which is why era-pair
  codepoints stay consistent. Each codepoint is pinned by majority vote of IEEE
  bytes derived from the timeline value (sub-unit payload drift loses minority
  votes); strict ties stay unpinned -> null (never fabricated). Decode unpacks
  the pinned bytes directly.
- u8 fields (kills 151, deaths 159, assists 167) hold the semantic value through the
  per-residue table; the cp->value bijection is read off truth pairing per field.
  Cross-field disagreements on rare values are reported, not silently merged.

Usage:
  python decode_statblocks.py --game NJ100-901131919780 [--truth dec_check.json]
Writes .tmp/decode_<game>.json and prints a summary.
"""
import argparse, collections, io, json, math, struct

U8_SLOTS = {"kills": 151, "deaths": 159, "assists": 167}
F32_LANES = {"minionsKilled": (119, False), "jungleMinionsKilled": (127, False),
             "xp": (79, False), "totalGold": (111, False)}
INT_LANES = {"minionsKilled": (119, 0), "jungleMinionsKilled": (127, 1)}
PERIOD = 64

def load_blocks(path):
    rows = [json.loads(l) for l in io.open(path, encoding="utf-8")]
    by_t = collections.defaultdict(dict)
    for r in rows:
        by_t[r["t"]][r["order"]] = bytes.fromhex(r["payload"])
    return sorted(by_t), by_t

def lane_cps(pay, o):
    return (pay[o], pay[o + 2], pay[o + 4], pay[o + 6])

def detect_pad(by_t):
    c = collections.Counter()
    for paymap in by_t.values():
        for pay in paymap.values():
            c.update(pay[0::2])
    return c.most_common(1)[0][0]

def u8_field_map(by_t, times, truth_series, slot):
    """cp -> value bijection from truth pairing; returns map, multiValued map."""
    cp2v = collections.defaultdict(set)
    for fi, t in enumerate(times):
        for i in range(10):
            tv = truth_series[fi][i]
            if tv is not None:
                cp2v[by_t[t][i][slot]].add(tv)
    multi = {c: sorted(v) for c, v in cp2v.items() if len(v) > 1}
    return {c: next(iter(v)) for c, v in cp2v.items() if len(v) == 1}, multi

def build_residue_map(by_t, times, chk, pad):
    """Per-residue table M[(offset % 64, cp)] -> byte, weighted majority vote + 2x rule.

    Votes: u8 bijection pins (semantic value == byte at the slot residue) x100,
    int-lane singleton candidate bytes x10, pad -> 0 x100 (per residue).
    Contested entries (top vote not 2x runner-up) stay unpinned -> decode null.
    """
    votes = collections.defaultdict(collections.Counter)
    for name, slot in U8_SLOTS.items():
        ser = chk["series"][name]
        cp2v = collections.defaultdict(collections.Counter)
        for fi, t in enumerate(times):
            for i in range(10):
                tv = ser[fi][i]
                if tv is not None:
                    cp2v[by_t[t][i][slot]][tv] += 1
        r = slot % PERIOD
        for cp, c in cp2v.items():
            if len(c) == 1:
                votes[(r, cp)][next(iter(c.keys()))] += 100
    for name, (o, tol) in INT_LANES.items():
        ser = chk["series"][name]
        for fi, t in enumerate(times):
            for i in range(10):
                tv = ser[fi][i]
                if tv is None:
                    continue
                cps = lane_cps(by_t[t][i], o)
                base = int(round(tv))
                cands = [struct.pack("<f", float(c)) for c in range(max(0, base - tol), base + tol + 1)]
                for k in range(4):
                    cp = cps[k]
                    r = (o + 2 * k) % PERIOD
                    if cp == pad:
                        votes[(r, cp)][0] += 100
                        continue
                    vals = {b[k] for b in cands}
                    if len(vals) == 1:
                        votes[(r, cp)][next(iter(vals))] += 10
    M, ambiguous = {}, []
    for key, c in votes.items():
        top = c.most_common(2)
        if len(top) == 1 or top[0][1] >= top[1][1] * 2:
            M[key] = top[0][0]
        else:
            ambiguous.append((key[0], hex(key[1]), dict(c)))
    return M, ambiguous

def derive_float_map(by_t, times, truth_series, o, M):
    """v12: pin xp/totalGold bytes directly from the timeline value.

    Stored layout (era-pair verified on the truth game): s0=m&255, s1=(m>>8)&255,
    s2=(m>>16)&0x7F | (E8&1)<<7, s3=E8>>1 (sign<<7 would ride s3 for negatives).
    E8 = 2*(s3&0x7F) + (s2>>7) reconstructs the IEEE exponent on decode. Per-cp
    majority vote across all occurrences absorbs sub-unit payload drift; strict
    ties stay unpinned (honest nulls). Returns (pinned, contested)."""
    votes = collections.defaultdict(collections.Counter)
    era_pairs = collections.defaultdict(collections.Counter)
    for fi, t in enumerate(times):
        for i in range(10):
            tv = truth_series[fi][i]
            if tv is None or tv <= 0:
                continue
            pay = by_t[t][i]
            bits = struct.unpack("<I", struct.pack("<f", tv))[0]
            E8 = (bits >> 23) & 0xFF
            m = bits & 0x7FFFFF
            deriv = {o + 6: E8 >> 1,
                     o + 4: ((E8 & 1) << 7) | (m >> 16),
                     o + 2: (m >> 8) & 255,
                     o: m & 255}
            for pos, b in deriv.items():
                votes[(pos % PERIOD, pay[pos])][b] += 1
            era_pairs[pay[o + 6]][E8] += 1
    pinned, contested = {}, []
    for key, c in votes.items():
        top = c.most_common(2)
        if len(top) == 2 and top[0][1] == top[1][1]:
            contested.append((key[0], hex(key[1]), dict(c)))
            continue
        M[key] = top[0][0]
        pinned[key] = top[0][0]
    multi = {hex(cp): dict(es) for cp, es in era_pairs.items() if len(es) > 1}
    return pinned, contested, multi

def mant_window(v, w):
    """Mantissa bounds of floats within [v-w, v+w]; None if the window spans an
    exponent boundary or the value is too small to anchor. w is in VALUE units
    (callers pass a multiple of the f32 grid at v)."""
    if v < 4:
        return None
    lo = v - w
    hi = v + w
    if lo < 0:
        return None
    bits = struct.unpack("<I", struct.pack("<f", v))[0]
    e = (bits >> 23) & 0xFF
    s = 2.0 ** (e - 127 - 23)
    base = float(1 << 23)
    m_lo = int(math.floor(lo / s)) - (1 << 23)
    while m_lo * s + base * s < lo:
        m_lo += 1
    m_hi = int(math.ceil(hi / s)) - (1 << 23)
    while m_hi * s + base * s > hi:
        m_hi -= 1
    if m_lo < 0 or m_hi >= (1 << 23) or m_lo > m_hi:
        return None  # exponent boundary crossed or empty
    e_lo = (struct.unpack("<I", struct.pack("<f", lo))[0] >> 23) & 0xFF
    e_hi = (struct.unpack("<I", struct.pack("<f", hi))[0] >> 23) & 0xFF
    if e_lo != e or e_hi != e:
        return None  # window crosses an exponent boundary
    return m_lo, m_hi, e

def floor_window(tv):
    """Mantissa interval of the payload value g under the verified floor-exact
    property (floor(g) == floor(tv)): g in [floor(tv), floor(tv)+1) shares one
    exponent, so the window is a single exact interval with no drift guessing.
    Returns (m_lo, m_hi, E) or None for values too small to anchor."""
    fl = math.floor(tv)
    if fl < 1:
        return None
    bits = struct.unpack("<I", struct.pack("<f", float(fl)))[0]
    E = (bits >> 23) & 0xFF
    k = E - 127
    if k < 0 or k > 20:
        return None
    m_lo = bits & 0x7FFFFF
    return m_lo, m_lo + (1 << (23 - k)) - 1, E

def dag_fill(samples, M, o):
    """Monotone-DAG gapFill for the low mantissa bytes (b1/b0) of a fractional
    lane. Variables are the per-residue byte values of the b1/b0 codepoints.
    Constraints: per-sample floor window (c + 256*y + z in [m_lo, m_hi]) and
    same-exponent consecutive-frame deltas ((c2-c1) + 256*dy + dz within the
    timeline delta +/- 1.5, the observed payload-vs-timeline drift bound).
    Interval/bounds propagation to a fixpoint; singletons pin, never fabricate."""
    ry, rz = (o + 2) % PERIOD, o % PERIOD
    cons_int, cons_pair = [], []
    seqs = {}
    for fi, i, cps, m_lo, m_hi, E, tv in sorted(samples, key=lambda s: (s[1], s[0])):
        b2 = M.get(((o + 4) % PERIOD, cps[2]))
        if b2 is None:
            continue
        c = (b2 & 0x7F) << 16
        cons_int.append((cps, c, m_lo, m_hi))
        seqs.setdefault(i, []).append((fi, cps, c, E, tv))
    for i, seq in seqs.items():
        for (f1, cps1, c1, E1, tv1), (f2, cps2, c2, E2, tv2) in zip(seq, seq[1:]):
            if f2 != f1 + 1 or E2 != E1:
                continue
            s = 2.0 ** (E1 - 150)
            dtv = tv2 - tv1
            dlo = math.floor((dtv - 1.5) / s)
            dhi = math.ceil((dtv + 1.5) / s)
            cons_pair.append((cps1, cps2, c1, c2, dlo, dhi))
    vars_ = set()
    for cps, c, m_lo, m_hi in cons_int:
        vars_.add((ry, cps[1]))
        vars_.add((rz, cps[0]))
    lo, hi, fixed = {}, {}, set()
    for v in vars_:
        if v in M:
            lo[v] = hi[v] = M[v]
            fixed.add(v)
        else:
            lo[v] = 0
            hi[v] = 255

    def ceildiv(a, b):
        return -((-a) // b)

    for _ in range(200):
        changed = False
        for cps, c, m_lo, m_hi in cons_int:
            yk, zk = (ry, cps[1]), (rz, cps[0])
            if yk in fixed and zk in fixed:
                continue
            A, B = m_lo - c, m_hi - c
            updates = (
                (yk, ceildiv(A - hi[zk], 256), (B - lo[zk]) // 256),
                (zk, A - 256 * hi[yk], B - 256 * lo[yk]),
            )
            for key, vlo, vhi in updates:
                if key in fixed:
                    continue
                if vlo > lo[key]: lo[key] = vlo; changed = True
                if vhi < hi[key]: hi[key] = vhi; changed = True
        for cps1, cps2, c1, c2, dlo, dhi in cons_pair:
            yk1, zk1 = (ry, cps1[1]), (rz, cps1[0])
            yk2, zk2 = (ry, cps2[1]), (rz, cps2[0])
            if yk1 not in lo or zk1 not in lo or yk2 not in lo or zk2 not in lo:
                continue
            D = dlo + (c1 - c2)
            Eu = dhi + (c1 - c2)
            updates = (
                (yk2, lo[yk1] + ceildiv(D - hi[zk2] + lo[zk1], 256),
                      hi[yk1] + (Eu - lo[zk2] + hi[zk1]) // 256),
                (yk1, lo[yk2] - (Eu - lo[zk2] + hi[zk1]) // 256,
                      hi[yk2] - ceildiv(D - hi[zk2] + lo[zk1], 256)),
                (zk2, lo[zk1] + D - 256 * (hi[yk2] - lo[yk1]),
                      hi[zk1] + Eu - 256 * (lo[yk2] - hi[yk1])),
                (zk1, lo[zk2] - Eu + 256 * (lo[yk2] - hi[yk1]),
                      hi[zk2] - D + 256 * (hi[yk2] - lo[yk1])),
            )
            for key, vlo, vhi in updates:
                if key in fixed:
                    continue
                if vlo > lo[key]: lo[key] = vlo; changed = True
                if vhi < hi[key]: hi[key] = vhi; changed = True
        if not changed:
            break
    return {v: lo[v] for v in sorted(vars_) if v not in fixed and lo[v] == hi[v]}

def cascade_resolve(by_t, times, truth_series, o, M):
    """Floor-exact interval cascade for a fractional-float lane, pinned into the
    PER-RESIDUE table. b3 follows from floor(tv)'s exponent directly, b2 from
    window intersection; b1/b0 come from the monotone-DAG bounds propagation.
    A (residue, cp) pins only on exact evidence (never fabricate)."""
    samples = []  # (fi, i, cps, m_lo, m_hi, E, tv)
    for fi, t in enumerate(times):
        for i in range(10):
            tv = truth_series[fi][i]
            if tv is None:
                continue
            fw = floor_window(tv)
            if fw is None:
                continue
            samples.append((fi, i, lane_cps(by_t[t][i], o), fw[0], fw[1], fw[2], tv))
    resolved_log = {}
    # b3: exponent of floor(tv) determines the byte directly
    for fi, i, cps, m_lo, m_hi, E, tv in samples:
        key = ((o + 6) % PERIOD, cps[3])
        if key not in M:
            M[key] = (127 + E) >> 1
            resolved_log["%s@r%d" % (hex(key[1]), key[0])] = "b3"
    # b2: intersection of floor windows (exponent parity rides the top bit)
    inter = collections.defaultdict(lambda: None)
    for fi, i, cps, m_lo, m_hi, E, tv in samples:
        key = ((o + 4) % PERIOD, cps[2])
        if key in M:
            continue
        cand = {((E & 1) << 7) | x for x in range(m_lo >> 16, (m_hi >> 16) + 1)}
        prev = inter[key]
        inter[key] = cand if prev is None else (prev & cand)
    for key, s in inter.items():
        if s and len(s) == 1:
            M[key] = next(iter(s))
            resolved_log["%s@r%d" % (hex(key[1]), key[0])] = "b2"
    # b1/b0: tight f32-grid windows (payload == f32(timeline), drift-free) intersected
    # per codepoint across all its occurrences; a singleton pins the byte.
    tight = collections.defaultdict(lambda: None)
    for fi, i, cps, m_lo, m_hi, E, tv in samples:
        bits = struct.unpack("<I", struct.pack("<f", tv))[0]
        grid = 2.0 ** (((bits >> 23) & 0xFF) - 150)
        mw = mant_window(tv, 2.0 * grid)
        if mw is None:
            continue
        for lvl in (1, 0):
            key = ((o + 2 * lvl) % PERIOD, cps[lvl])
            if key in M:
                continue
            base = 0
            ok = True
            for k in range(lvl + 1, 3):
                b = M.get(((o + 2 * k) % PERIOD, cps[k]))
                if b is None:
                    ok = False
                    break
                base |= ((b & 0x7F) if k == 2 else b) << (8 * k)
            if not ok:
                continue
            cand = set(range(max(0, mw[0] - base), min(255, mw[1] - base) + 1))
            prev = tight[key]
            tight[key] = cand if prev is None else (prev & cand)
    for key, s in tight.items():
        if s and len(s) == 1:
            M[key] = next(iter(s))
            resolved_log["%s@r%d" % (hex(key[1]), key[0])] = "tight"
    # b1/b0 stragglers: monotone-DAG bounds propagation
    for (r, cp), b in dag_fill(samples, M, o).items():
        M[(r, cp)] = b
        resolved_log["%s@r%d" % (hex(cp), r)] = "b1" if r == (o + 2) % PERIOD else "b0"
    return resolved_log, len(samples)

def decode_f32(by_t, times, o, M, stored=False):
    """stored=True: xp/totalGold lanes keep the split-exponent layout in M; rebuild
    the IEEE bytes as [s0, s1, s2&0x7F, 2*(s3&0x7F)+(s2>>7)] before unpacking."""
    out, cov = [], [0, 0]
    for t in times:
        frame = []
        for i in range(10):
            bs = [M.get(((o + 2 * k) % PERIOD, by_t[t][i][o + 2 * k])) for k in range(4)]
            if all(b is not None for b in bs):
                raw = bytes(bs)
                if stored:
                    s3, s2 = bs[3], bs[2]
                    raw = bytes([bs[0], bs[1], s2 & 0x7F, 2 * (s3 & 0x7F) + ((s2 >> 7) & 1)])
                v = struct.unpack("<f", raw)[0]
                if v != v:
                    v = None  # NaN from inconsistent pins: report as uncovered
                cov[0] += 1 if v is not None else 0
                cov[1] += 0 if v is not None else 1
                frame.append(v)
            else:
                cov[1] += 1
                frame.append(None)
        out.append(frame)
    return out, cov

def score(series, truth):
    exact = within1 = floor_ok = total = 0
    maxerr = 0.0
    for fi in range(len(series)):
        for i in range(10):
            tv, dv = truth[fi][i], series[fi][i]
            if tv is None or dv is None or dv != dv:
                continue
            total += 1
            e = abs(dv - tv)
            maxerr = max(maxerr, e)
            if dv == tv: exact += 1
            if e <= 1: within1 += 1
            if int(dv) == int(tv): floor_ok += 1
    return exact, within1, floor_ok, total, maxerr

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--statblocks", default=r"C:/Temp/obs4/statblocks")
    ap.add_argument("--index", default=r"C:/Temp/obs4/corpus/index.json")
    ap.add_argument("--truth", default=r"C:/Temp/obs4/dec_check.json")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    times, by_t = load_blocks(f"{args.statblocks}/{args.game}.jsonl")
    with io.open(args.index, encoding="utf-8") as f:
        idx = json.load(f)
    meta = idx["games"][args.game]
    pad = detect_pad(by_t)
    chk = json.load(io.open(args.truth, encoding="utf-8"))
    report = {"game": args.game, "version": meta["version"], "pad": pad, "times": times,
              "model": f"per-residue table byte=M[offset%{PERIOD}][cp]", "fields": {}}
    print("pad:", hex(pad), "times:", len(times), flush=True)

    # --- u8 fields: per-field bijection ---
    for name, slot in U8_SLOTS.items():
        cp2v, multi = u8_field_map(by_t, times, chk["series"][name], slot)
        series = [[cp2v.get(by_t[t][i][slot]) for i in range(10)] for t in times]
        mism = sum(1 for fi in range(len(times)) for i in range(10)
                   if chk["series"][name][fi][i] is not None and series[fi][i] != chk["series"][name][fi][i])
        report["fields"][name] = {"type": "u8-bijection", "slot": slot, "distinct": len(cp2v),
                                  "multiValued": {hex(k): v for k, v in multi.items()},
                                  "mismatches": mism, "series": series}
        print(f"{name}: bijection={len(cp2v)} multiValued={len(multi)} mismatches={mism}", flush=True)

    dual_ok = all(by_t[t][i][151] == by_t[t][i][862] for t in times for i in range(10))
    report["dualSlot"] = {"slots": [151, 862], "rawEqual": dual_ok}
    print("dualSlot 151/862 rawEqual:", dual_ok, flush=True)

    # --- per-residue table: weighted vote + 2x ambiguity rule ---
    M, ambiguous = build_residue_map(by_t, times, chk, pad)
    print(f"residue table: {len(M)} pinned entries, ambiguous: {len(ambiguous)}", flush=True)
    for r, cp, v in ambiguous:
        print(f"  ambiguous r={r} cp={cp}: {v}", flush=True)

    # --- xp/totalGold: direct derivation pins (split exponent, majority vote) ---
    for name in ("xp", "totalGold"):
        o = F32_LANES[name][0]
        pinned, contested, multi = derive_float_map(by_t, times, chk["series"][name], o, M)
        print(f"{name}: derived pins={len(pinned)} contested={len(contested)}", flush=True)
        for r0, cp, c in contested:
            print(f"  contested r={r0} cp={cp}: {c}", flush=True)
        print(f"  b3 era-spanning cps: {multi if multi else 'none'}", flush=True)

    # --- decode all f32 lanes ---
    for name, (o, stored) in F32_LANES.items():
        series, cov = decode_f32(by_t, times, o, M, stored=stored)
        exact, within1, floor_ok, total, maxerr = score(series, chk["series"][name])
        report["fields"][name] = {"type": "f32", "off": o, "laneCov": cov, "exact": exact,
                                  "within1": within1, "floorOk": floor_ok, "total": total,
                                  "maxErr": round(maxerr, 3), "series": series}
        print(f"{name}: laneCov={cov} exact={exact}/{total} within1={within1} floorOk={floor_ok} maxErr={maxerr:.2f}", flush=True)
    report["tableEntries"] = len(M)
    report["tableAmbiguous"] = [[r, cp, v] for r, cp, v in ambiguous]
    outp = args.out or f".tmp/decode_{args.game}.json"
    with io.open(outp, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False)
    print("report:", outp)

if __name__ == "__main__":
    main()
