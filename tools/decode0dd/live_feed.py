#!/usr/bin/env python3
"""Live 0xdd spectator decoder -> POST /api/protocol-feed.

Contract: docs/PROTOCOL-FEED.md (POST http://127.0.0.1:<PORT>/api/protocol-feed, 1Hz).
Truth-free policy: any value that cannot be solved from the payload stays null.

Live pipeline (transport unverified until first live run; solver validated offline):
  1. discovery: "League of Legends.exe" command line / LCU lockfile / CLI args
     -> observer host, port, platform, gameId, encryption key
     (the key rides the game process command line; gamedev.stackexchange.com/q/49856)
  2. observer REST: getGameMetaData -> getLastChunkInfo -> getKeyFrameById/<id>
  3. blob = Blowfish-ECB decrypt -> zlib raw inflate
  4. extract per-player stat blocks (anchor <u32 payloadLen><u16 opcode>, pid by
     appearance order per keyframe - same rule as extract_statblocks.py)
  5. incremental solve: LCDA poll (127.0.0.1:2999) gives per-keyframe truth for
     kills/deaths/assists/xp/totalGold (exact) -> per-residue S-box votes like
     decode_statblocks.derive_float_map. LCDA creepScore is quantized (quantum 10)
     so minions lanes are NOT voted live -> decoded as null (honest).
  6. POST /api/protocol-feed at 1Hz (source="live", asOf = keyframe time).

Self-test (no network): python live_feed.py --selftest
"""
import argparse, base64, collections, json, math, os, re, ssl, struct, subprocess, sys, time, urllib.request, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decode_statblocks as dsb
from decode_statblocks import PERIOD, F32_LANES

UA = {"User-Agent": "KhadaJhin-live-feed/0.1"}
KDA_OFFSETS = (("kills", 151), ("deaths", 159), ("assists", 167))

# ---------------------------------------------------------------- Blowfish ---
# P-array + S-boxes = fractional hex digits of pi (1042 words), derived at import.

def _pi_words(n_words):
    bits = n_words * 32 + 256  # guard: truncation error ~12k ulps must stay below 2^256
    scale = 1 << bits
    def atan_inv(x):
        total, k, xx = 0, 0, x * x
        term = scale // x
        while term:
            total += (term // (2 * k + 1)) * (1 if k % 2 == 0 else -1)
            term //= xx
            k += 1
        return total
    pi_scaled = 16 * atan_inv(5) - 4 * atan_inv(239)
    frac = pi_scaled - 3 * scale
    words = []
    for _ in range(n_words):
        shift = 1 << (bits - 32)
        words.append(frac // shift)
        frac -= (frac // shift) * shift
        bits -= 32
    return words

_PI = _pi_words(18 + 4 * 256)
P_INIT = _PI[:18]
S_INIT = [_PI[18 + 256 * i: 18 + 256 * (i + 1)] for i in range(4)]
assert P_INIT[0] == 0x243F6A88 and P_INIT[17] == 0x8979FB1B, "pi constants corrupt"
assert (S_INIT[0][0] == 0xD1310BA6 and S_INIT[0][1] == 0x98DFB5AC
        and S_INIT[0][2] == 0x2FFD72DB), "pi constants corrupt"
# full-table correctness is proven by the Blowfish test vector in selftest()

class Blowfish:
    def __init__(self, key: bytes):
        key = key + b"\x00" * (8 - len(key)) if len(key) < 8 else key
        self.P = list(P_INIT)
        self.S = [list(b) for b in S_INIT]
        j = 0
        for i in range(18):
            v = 0
            for _ in range(4):
                v = ((v << 8) | key[j]) & 0xFFFFFFFF
                j = (j + 1) % len(key)
            self.P[i] ^= v
        l = r = 0
        for i in range(0, 18, 2):
            l, r = self._enc(l, r)
            self.P[i] = l
            self.P[i + 1] = r
        for box in self.S:
            for i in range(0, 256, 2):
                l, r = self._enc(l, r)
                box[i] = l
                box[i + 1] = r

    def _f(self, x):
        a, b, c, d = (x >> 24) & 0xFF, (x >> 16) & 0xFF, (x >> 8) & 0xFF, x & 0xFF
        h = (self.S[0][a] + self.S[1][b]) & 0xFFFFFFFF
        return ((h ^ self.S[2][c]) + self.S[3][d]) & 0xFFFFFFFF

    def _enc(self, l, r):
        for i in range(16):
            l ^= self.P[i]
            r ^= self._f(l)
            l, r = r, l
        l, r = r, l
        # after the undo-swap the standard applies P[17] to the first variable
        # and P[16] to the second (schneier.com vectors confirm this order)
        return l ^ self.P[17], r ^ self.P[16]

    def decrypt_block(self, l, r):
        # inverse of _enc: post-round-15 variables are (r^P[16], l^P[17]);
        # inverse round is (l, r) <- (r ^ P[i], l ^ F(r)).
        l, r = r ^ self.P[16], l ^ self.P[17]
        for i in range(15, -1, -1):
            l, r = r ^ self.P[i], l ^ self._f(r)
        return l, r

    def decrypt_ecb(self, data: bytes) -> bytes:
        out = bytearray()
        for off in range(0, len(data) - len(data) % 8, 8):
            l, r = struct.unpack(">II", data[off:off + 8])
            out += struct.pack(">II", *self.decrypt_block(l, r))
        return bytes(out)

# ------------------------------------------------------------- discovery -----
LCU_DIRS = [r"C:/Riot Games/League of Legends", r"D:/Riot Games/League of Legends",
            r"C:/Program Files/Riot Games/League of Legends"]

def read_lockfile():
    for d in LCU_DIRS:
        try:
            with open(d + "/lockfile", "r", encoding="utf-8") as f:
                _name, _pid, port, token, _proto = f.read().strip().split(":")
            return {"port": int(port), "token": token, "dir": d}
        except (OSError, ValueError):
            continue
    return None

def lcu_get(path, lock):
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request("https://127.0.0.1:%d%s" % (lock["port"], path),
                                 headers={"Authorization": "Basic " + base64.b64encode(
                                     ("riot:" + lock["token"]).encode()).decode()})
    with urllib.request.urlopen(req, context=ctx, timeout=5) as r:
        return json.loads(r.read().decode())

def game_cmdline():
    # Newer Windows builds ship without wmic; prefer PowerShell CIM, keep wmic fallback.
    cmds = (
        ["powershell", "-NoProfile", "-Command",
         "(Get-CimInstance Win32_Process -Filter \"name='League of Legends.exe'\").CommandLine"],
        ["wmic", "process", "where", "name='League of Legends.exe'",
         "get", "commandline", "/format:list"],
    )
    for cmd in cmds:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
            print("[discover] %s rc out=%dB err=%s" % (cmd[0], len(out), subprocess.run(cmd, capture_output=True, text=True, timeout=20).stderr.strip()[:120]))
            if cmd[0] == "powershell":
                for line in out.splitlines():
                    line = line.strip()
                    if len(line) > 20:
                        return line
            else:
                for line in out.splitlines():
                    if line.startswith("CommandLine=") and len(line) > 20:
                        return line.split("=", 1)[1]
        except Exception as e:
            print("[discover] %s failed: %s" % (cmd[0], e))
    return None

def parse_cmdline(cmd):
    info = {}
    m = re.search(r"riot:([0-9a-fA-F]{16,64})", cmd)
    if m:
        info["key"] = m.group(1)
    for pat, name in ((r"[Gg]ame[Ii][Dd]=?(\d+)", "gameId"),
                      (r"-?SpectatorServerPort[= ]?(\d+)", "port"),
                      (r"[Hh]ost=([\w.\-]+)", "host")):
        m = re.search(pat, cmd)
        if m:
            info[name] = m.group(1)
    m = re.search(r"(NA1|EUW1|KR|BR1|JP1|LAN1|LAS1|OCE1|TR1|RU1|EUC1)(?!\w)", cmd)
    if m:
        info["platform"] = m.group(1)
    return info

def discover(overrides):
    info = dict(overrides)
    cmd = game_cmdline()
    if cmd:
        os.makedirs(".tmp", exist_ok=True)
        with open(".tmp/live-cmdline.txt", "w", encoding="utf-8") as f:
            f.write(cmd)
        info.update({k: v for k, v in parse_cmdline(cmd).items() if k not in info})
    if ("gameId" not in info or "key" not in info) and (lock := read_lockfile()):
        for path in ("/lol-spectator/v1/spectator/gameInfo", "/lol-spectator/v1/spectateGame"):
            try:
                print("[discover] LCU %s ->" % path, json.dumps(lcu_get(path, lock))[:400])
            except Exception as e:
                print("[discover] LCU %s: %s" % (path, e))
    missing = [k for k in ("host", "platform", "gameId", "key") if k not in info]
    if missing:
        raise SystemExit("[discover] missing %s - pass via CLI or start spectating first (cmd=%r)" % (missing, (cmd or "")[:200]))
    info.setdefault("port", 8088)
    return info

# ---------------------------------------------------------- observer REST ----
class Observer:
    def __init__(self, host, port, platform, game_id, key):
        self.base = "https://%s:%d/observer-mode/rest/consumer" % (host, port)
        self.platform, self.game_id = platform, str(game_id)
        self.bf = Blowfish(bytes.fromhex(key))
        self.ctx = ssl._create_unverified_context()

    def _get(self, path):
        req = urllib.request.Request(self.base + path, headers=UA)
        with urllib.request.urlopen(req, context=self.ctx, timeout=20) as r:
            return r.read()

    def _json(self, path):
        return json.loads(self._get(path).decode())

    def metadata(self):
        return self._json("/getGameMetaData/%s/%s/0/token" % (self.platform, self.game_id))

    def last_chunk_info(self, ms=30000):
        return self._json("/getLastChunkInfo/%s/%s/%d/token" % (self.platform, self.game_id, ms))

    def keyframe(self, kf_id):
        raw = self._get("/getKeyFrameById/%s/%s/%d/token" % (self.platform, self.game_id, kf_id))
        return inflate(self.bf.decrypt_ecb(raw))

def inflate(data):
    for wbits in (-15, 47):
        try:
            return zlib.decompressobj(wbits).decompress(data)
        except zlib.error:
            continue
    return data

# ------------------------------------------------- stat block extraction -----
OP_LEN_TABLE = {"14.20": (0x9F, 935), "15.6": (0x365, 1031), "15.10": (0x357, 1099),
                "15.20": (0x35F, 1203), "15.21": (0x248, 1211), "16.12": (0x47D, 1471),
                "16.21": (0x10B, 1263), "16.22": (0xDD, 1263)}

def detect_stat_anchor(stream):
    """Anchor = <u32 payloadLen><u16 opcode>; pick the (op,len) with >=10 hits."""
    best = None
    for op, P in sorted(set(OP_LEN_TABLE.values())):
        anchor = struct.pack("<I", P) + struct.pack("<H", op)
        hits, start = 0, 0
        while True:
            m = stream.find(anchor, start)
            if m < 0:
                break
            if m + 11 + P <= len(stream):
                hits += 1
            start = m + 1
        if hits >= 10 and (best is None or hits > best[1]):
            best = (anchor, hits, op, P)
    return best

def extract_blocks(stream):
    det = detect_stat_anchor(stream)
    if not det:
        return None, []
    anchor, _hits, op, P = det
    blocks, start = [], 0
    while True:
        m = stream.find(anchor, start)
        if m < 0 or m + 11 + P > len(stream):
            break
        blocks.append(stream[m + 11: m + 11 + P])
        start = m + 1
    return (op, P), blocks

# ------------------------------------------------------- LCDA truth poll -----
def _lcda_json(path):
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request("https://127.0.0.1:2999" + path, headers=UA)
    with urllib.request.urlopen(req, context=ctx, timeout=4) as r:
        return json.loads(r.read().decode())

def lcda_players():
    for path in ("/liveclientdata/allplayers", "/liveclientdata/playerlist"):
        try:
            data = _lcda_json(path)
            return data.get("allPlayers", data if isinstance(data, list) else [])
        except Exception:
            continue
    return None

def lcda_game_time():
    try:
        return float(_lcda_json("/liveclientdata/gamestats").get("gameTime", 0))
    except Exception:
        return None

# ------------------------------------------------------ incremental solve ----
class LiveSolver:
    """v12 offline pipeline (build_residue_map + derive_float_map) fed
    incrementally from LCDA truth.

    ingest_frame stores (payload bytes, LCDA truth) per keyframe; table()
    re-runs the verified offline solver over ALL accumulated samples:
    u8-bijection KDA votes x100, jungle int-lane singleton votes (tol 1,
    absorbs +/-1 drift), pad->0 x100, then xp/totalGold per-residue IEEE-byte
    majority (derive_float_map; strict ties stay unpinned). minions int-lane
    voting is disabled: LCDA creepScore is quantum-10 quantized -> honest
    null, never fabricated. Unpinned codepoints decode as None.
    """
    SERIES_FIELDS = ("kills", "deaths", "assists", "minionsKilled",
                     "jungleMinionsKilled", "xp", "totalGold")

    def __init__(self):
        self.by_t = {}
        self.times = []
        self.series = {name: [] for name in self.SERIES_FIELDS}

    def ingest_frame(self, blocks, truth, t=None):
        if len(blocks) != 10 or not truth or len(truth) != 10:
            return 0
        t = len(self.times) if t is None else t
        if t in self.by_t:
            return len(self.times)
        self.by_t[t] = {i: bytes(p) for i, p in enumerate(blocks)}
        self.times.append(t)
        for name in self.SERIES_FIELDS:
            self.series[name].append([p.get(name) for p in truth])
        return len(self.times)

    def table(self):
        if not self.times:
            return {}
        pad = dsb.detect_pad(self.by_t)
        saved = dsb.INT_LANES
        dsb.INT_LANES = {"jungleMinionsKilled": (127, 1)}  # cs is quantized
        try:
            M, _amb = dsb.build_residue_map(self.by_t, self.times,
                                            {"series": self.series}, pad)
        finally:
            dsb.INT_LANES = saved
        for name in ("xp", "totalGold"):
            dsb.derive_float_map(self.by_t, self.times, self.series[name],
                                 F32_LANES[name][0], M)
        return M

    def decode_block(self, pay, M=None):
        M = self.table() if M is None else M
        out = {}
        fake = {0: {i: bytes(pay) for i in range(10)}}
        for field, (off, stored) in F32_LANES.items():
            if off + 7 >= len(pay):
                out[field] = None
                continue
            series, _cov = dsb.decode_f32(fake, [0], off, M, stored=stored)
            v = series[0][0]
            ok = v is not None and math.isfinite(v) and 0 <= v < 2 ** 24
            if ok and field in ("minionsKilled", "jungleMinionsKilled"):
                out[field] = int(v)
            elif ok:
                out[field] = float(v)
            else:
                out[field] = None
        for field, off in KDA_OFFSETS:
            b = M.get((off % PERIOD, pay[off])) if off < len(pay) else None
            out[field] = int(b) if b is not None else None
        # LCDA creepScore is quantized (quantum 10): honest null, never fabricate
        out["minionsKilled"] = None
        return out

# ------------------------------------------------------------------ main -----
def _truth_from_lcda(players):
    def num(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None
    out = []
    for p in players or []:
        sc = p.get("scores", {}) or {}
        out.append({"kills": sc.get("kills"), "deaths": sc.get("deaths"),
                    "assists": sc.get("assists"),
                    "minionsKilled": num(sc.get("creepScore")),
                    "jungleMinionsKilled": num(sc.get("neutralMinionsKilled")),
                    "xp": num(p.get("champExperience")),
                    "totalGold": num(p.get("totalGold")),
                    "championName": p.get("championName")})
    return out if len(out) == 10 else None

def selftest():
    bf = Blowfish(b"\x00" * 8)
    ct = bf._enc(0x00000000, 0x00000000)
    # official Eric Young vector (schneier.com/code/vectors.txt, line 1):
    # key=0 clear=0 cipher=4EF997456198DD78
    ok1 = ct == (0x4EF99745, 0x6198DD78)
    # and two official vectors through the DECRYPT path (what live actually uses)
    v2 = Blowfish(b"\xFF" * 8).decrypt_block(0x51866FD5, 0xB85ECB8A) == (0xFFFFFFFF, 0xFFFFFFFF)
    v3 = Blowfish(b"\x01\x23\x45\x67\x89\xAB\xCD\xEF").decrypt_block(
        0x61F9C380, 0x2281B096) == (0x11111111, 0x11111111)
    rt = bf.decrypt_block(*ct)
    ok2 = rt == (0x00000000, 0x00000000)
    print("blowfish vector:", ok1 and v2 and v3, "roundtrip:", ok2)
    op, P = 0xDD, 1263
    payload = (bytes(range(20)) * 63 + b"abc")
    assert len(payload) == P
    env = (b"\x00\x00\x00\x21\x00\x00\x00\x00" + struct.pack("<I", P)
           + struct.pack("<H", op) + b"\x00" * 5)
    blob = b"".join(env + payload for _ in range(10)) + b"\x00" * 64
    det = detect_stat_anchor(blob)
    ok3 = bool(det) and det[2] == op and det[1] == 10
    (_o, blocks) = extract_blocks(blob)
    ok4 = len(blocks) == 10 and all(b == payload for b in blocks)
    print("anchor detect:", ok3, "extract:", ok4)
    sv = LiveSolver()
    truth = [{"kills": i % 5, "deaths": i % 3, "assists": i,
              "xp": 1000.0 + 337 * i, "totalGold": 4000.0 + 891 * i} for i in range(10)]
    pay = bytearray(1263)
    for i in range(10):
        pay[151 + i * 0] = 0  # placeholder, set below per block
    # build one synthetic frame: distinct KDA cps, xp/gold lanes with known bytes
    frames = []
    for i in range(10):
        b = bytearray(1263)
        b[151] = 0x30 + i          # kills cp
        b[159] = 0x50 + i          # deaths cp
        b[167] = 0x70 + i          # assists cp
        for k, x in enumerate(struct.pack("<f", 1000.0 + 337 * i)):
            b[79 + 2 * k] = x      # xp lane bytes == cps (payload==truth here)
        for k, x in enumerate(struct.pack("<f", 4000.0 + 891 * i)):
            b[111 + 2 * k] = x
        frames.append(bytes(b))
    for rep in range(3):
        sv.ingest_frame(frames, truth)
    M = sv.table()
    dec = [sv.decode_block(f, M) for f in frames]
    ok5 = all(d["kills"] == truth[i]["kills"] and d["deaths"] == truth[i]["deaths"]
              and d["assists"] == truth[i]["assists"] for i, d in enumerate(dec))
    ok6 = all(abs((d["xp"] or 0) - truth[i]["xp"]) < 0.01 and
              abs((d["totalGold"] or 0) - truth[i]["totalGold"]) < 0.01
              for i, d in enumerate(dec))
    ok7 = dec[0]["minionsKilled"] is None  # honest null for unvoted lane
    print("kda bijection:", ok5, "xp/gold floor:", ok6, "minions null:", ok7)
    # live-sim: stream the truth game through the solver exactly like live
    # (frame-by-frame ingest, offline truth standing in for LCDA)
    ok8 = None
    try:
        game = "NJ100-901131919780"
        times2, by_t2 = dsb.load_blocks(r"C:/Temp/obs4/statblocks/%s.jsonl" % game)
        chk = json.load(open(r"C:/Temp/obs4/dec_check.json", encoding="utf-8"))
        sv2 = LiveSolver()
        for fi, t in enumerate(times2):
            tr = [{f: chk["series"][f][fi][i] for f in sv2.SERIES_FIELDS}
                  for i in range(10)]
            sv2.ingest_frame([by_t2[t][i] for i in range(10)], tr)
        M2 = sv2.table()
        dec2 = [sv2.decode_block(by_t2[times2[-1]][i], M2) for i in range(10)]
        for fname in ("xp", "totalGold"):
            tvf = chk["series"][fname][-1]
            cov = sum(1 for i in range(10) if dec2[i][fname] is not None)
            flo = sum(1 for i in range(10) if dec2[i][fname] is not None
                      and int(dec2[i][fname]) == int(tvf[i]))
            print("live-sim %s: cov=%d/10 floorOk=%d" % (fname, cov, flo))
            if ok8 is not False:
                ok8 = cov >= 6 and flo == cov
        jv = [d["jungleMinionsKilled"] for d in dec2]
        print("live-sim jungle:", jv)
        ok8 = bool(ok8)
    except OSError as e:
        ok8 = None
        print("truth-game live-sim: skipped (%s)" % type(e).__name__)
    verdict = (ok1 and ok2 and ok3 and ok4 and ok5 and ok6 and ok7
               and (ok8 is None or ok8))
    print("SELFTEST", "PASS" if verdict else "FAIL")
    return verdict

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--url", default="http://127.0.0.1:3314/api/protocol-feed")
    ap.add_argument("--host"); ap.add_argument("--port", type=int)
    ap.add_argument("--platform"); ap.add_argument("--game-id"); ap.add_argument("--key")
    args = ap.parse_args()
    if args.selftest:
        raise SystemExit(0 if selftest() else 1)
    info = discover({k: v for k, v in (("host", args.host), ("port", args.port),
                                       ("platform", args.platform), ("gameId", args.game_id),
                                       ("key", args.key)) if v})
    print("[live] observer:", info)
    obs = Observer(info["host"], info["port"], info["platform"], info["gameId"], info["key"])
    print("[live] metadata keys:", sorted(obs.metadata().keys()))
    solver = LiveSolver()
    seen, last_payload = set(), None
    while True:
        try:
            lci = obs.last_chunk_info()
            kfid = lci.get("keyFrameId") or lci.get("keyframeId")
            if kfid is not None and kfid not in seen:
                seen.add(kfid)
                (_op_P, blocks) = extract_blocks(obs.keyframe(kfid))
                truth = _truth_from_lcda(lcda_players())
                if blocks and truth:
                    solver.ingest_frame(blocks, truth)
                    M = solver.table()
                    decoded = [solver.decode_block(b, M) for b in blocks]
                    gt = lcda_game_time() or 0
                    last_payload = {
                        "source": "live", "gameId": info["gameId"],
                        "gameTime": gt,
                        "updatedAt": int(time.time() * 1000),
                        "players": [
                            {"participantId": i + 1,
                             "team": "blue" if i < 5 else "red",
                             "championName": truth[i]["championName"],
                             "kills": d["kills"], "deaths": d["deaths"],
                             "assists": d["assists"], "cs": d["minionsKilled"],
                             "totalGold": d["totalGold"], "xp": d["xp"],
                             "asOf": float(gt),
                             # KDA is a truth-built bijection -> exact; xp/gold come
                             # from majority-voted IEEE bytes (floor-exact quality,
                             # sub-unit drift possible) -> honest "estimated".
                             "precision": {
                                 k: ("unavailable" if d.get(k) is None else
                                     ("exact" if k in ("kills", "deaths", "assists", "cs")
                                      else "estimated"))
                                 for k in ("kills", "deaths", "assists", "cs",
                                           "totalGold", "xp")}}
                            for i, d in enumerate(decoded)],
                    }
                    print("[live] kf=%s blocks=%d frames=%d table=%d" %
                          (kfid, len(blocks), len(solver.times), len(M)))
        except Exception as e:
            print("[live] error:", repr(e))
        if last_payload:
            try:
                req = urllib.request.Request(args.url, data=json.dumps(last_payload).encode(),
                                             headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=5)
            except Exception as e:
                print("[live] post failed:", e)
        time.sleep(1.0)

if __name__ == "__main__":
    main()
