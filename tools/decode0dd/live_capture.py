#!/usr/bin/env python3
"""Live spectate corpus recorder.

Records everything needed to turn ONE spectated game into a permanent test
corpus (same shape as C:/Temp/obs4), under --out (default C:/Temp/obs-live):

  <out>/<gameId>/
    meta.json               observer metadata + discovery info (incl. key:
                            the per-game S-box/transport key is required to
                            decrypt stored blobs later and dies with the
                            game process, so it MUST be captured live)
    chunkinfo.jsonl         every changed getLastChunkInfo poll
    chunks/chunk_NNNNN.bin  raw encrypted chunk blobs
    keyframes/kf_NNNN.bin   raw encrypted keyframe blobs
    keyframes/kf_NNNN.dec   Blowfish-ECB decrypted + inflated keyframe
    statblocks.jsonl        {t,pid1,order,id,payload(hex)} rows, one per
                            player block - directly consumable by
                            decode_statblocks.load_blocks()
    lcda/snap-NNNNNN.json   every CHANGED LCDA allgamedata snapshot (truth)
    lcda/events.jsonl       deduped LCDA events (identity key, cf. main.js)
    manifest.json           run summary, updated continuously

Modes:
  - full: observer REST available (key + gameId + platform resolved). Records
    encrypted blobs, decrypted keyframes and stat blocks + LCDA truth.
  - lcda-only: no key (e.g. elevation declined). Still records ground truth
    snapshots + events; prints how to grant key access.

LCDA (127.0.0.1:2999) is a self-signed TLS service; http plaintext HANGS.
Usage:
  python live_capture.py                 # wait for a game, record until it ends
  python live_capture.py --elevate       # also pop ONE UAC prompt to dump the key
  python live_capture.py --key hex --game-id N --platform NJ100   # manual
  python live_capture.py --selftest
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_feed as lf
from live_feed import Blowfish, Observer, game_cmdline, parse_cmdline, inflate, \
    detect_stat_anchor, extract_blocks, _lcda_json

UA = lf.UA
ELEVATED_KEY_FILE = r"C:/Temp/live-cmdline-elevated.txt"
ELEVATED_LOCKFILE = r"C:/Temp/lcu-lockfile-elevated.txt"
DUMP_KEY_PS1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dump_key_admin.ps1")
LCDA_TIMEOUT_S = 60          # game considered over after this much LCDA silence
DISCOVERY_GIVEUP_S = 300     # lcda-only fallback window for key discovery
PLATFORM_PROBE_EXTRA = ("NJ100", "TTP1", "KZ01")   # WeGame/国服 candidates to probe


def lcda_all():
    return _lcda_json("/liveclientdata/allgamedata")


def _game_cmdline_quiet():
    """Non-admin CIM probe without live_feed's noisy diagnostics prints."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance Win32_Process -Filter \"name='League of Legends.exe'\").CommandLine"],
            capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return None
    for line in out.splitlines():
        line = line.strip()
        if len(line) > 20:
            return line
    return None


def _parse_host(line):
    m = re.search(r"[Hh]ost=([\w.\-]+)", line or "")
    return m.group(1) if m else None


def event_key(ev):
    return json.dumps([ev.get("EventName"), ev.get("KillerName"), ev.get("VictimName"),
                       ev.get("TurretKilled"), ev.get("DragonType"),
                       ev.get("AssistingUnitNames"), ev.get("MultiKillLength")],
                      ensure_ascii=False, sort_keys=True)


def platform_candidates(cmd, overrides):
    """Broadened platform candidates, validated later by a metadata probe.

    parse_cmdline's hardcoded region list misses CN/WeGame codes (NJ100...),
    so fall back to any 2-4 letters + 2-4 digits token that is not part of a
    path/flag value, plus known CN candidates.
    """
    out = []
    if overrides.get("platform"):
        out.append(overrides["platform"])
    m = parse_cmdline(cmd or "")
    if m.get("platform"):
        out.append(m["platform"])
    seen = set()
    for tok in re.findall(r"(?<![\/:._\w])([A-Z]{2,4}\d{2,4})(?![A-Za-z0-9])", cmd or ""):
        if tok not in seen and tok.upper() not in ("WIN32", "DX11", "DX12"):
            seen.add(tok)
            out.append(tok)
    for tok in PLATFORM_PROBE_EXTRA:
        if tok not in seen:
            out.append(tok)
    return out


class Recorder:
    def __init__(self, outroot):
        self.outroot = outroot
        self.dirs = None
        self.game_id = None
        self.info = {}
        self.snap_count = 0
        self.last_snap_hash = None
        self.kf_seen = set()
        self.next_chunk = 1
        self.next_chunk_limit = 0
        self.last_chunkinfo = None
        self.event_keys = set()
        self.events = 0
        self.stat_rows = 0
        self.last_lcda_ok = None
        self.lcda_ever_ok = False

    def setup_dirs(self, game_id):
        self.game_id = str(game_id)
        base = os.path.join(self.outroot, self.game_id)
        self.dirs = {"base": base,
                     "lcda": os.path.join(base, "lcda"),
                     "chunks": os.path.join(base, "chunks"),
                     "kf": os.path.join(base, "keyframes")}
        for d in self.dirs.values():
            os.makedirs(d, exist_ok=True)

    def _append(self, relpath, text):
        with open(os.path.join(self.dirs["base"], relpath), "a", encoding="utf-8") as f:
            f.write(text.rstrip("\n") + "\n")

    def manifest(self, **kw):
        try:
            man = json.load(open(os.path.join(self.dirs["base"], "manifest.json"), encoding="utf-8"))
        except Exception:
            man = {}
        man.update(kw)
        man["updatedAt"] = int(time.time() * 1000)
        man["counts"] = {"lcdaSnaps": self.snap_count, "events": self.events,
                         "statRows": self.stat_rows,
                         "keyframes": len(self.kf_seen),
                         "chunks": max(0, self.next_chunk - 1)}
        with open(os.path.join(self.dirs["base"], "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(man, f, ensure_ascii=False, indent=1)

    # ------------------------------------------------------------- LCDA ----
    def poll_lcda(self):
        try:
            snap = lcda_all()
        except Exception:
            return False
        self.last_lcda_ok = time.time()
        self.lcda_ever_ok = True
        blob = json.dumps(snap, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha1(blob.encode()).hexdigest()
        if h == self.last_snap_hash:
            return True
        self.last_snap_hash = h
        self.snap_count += 1
        name = "snap-%06d.json" % self.snap_count
        with open(os.path.join(self.dirs["lcda"], name), "w", encoding="utf-8") as f:
            f.write(blob)
        evs = (snap.get("eventData") or {}).get("Events") or []
        new = 0
        for ev in evs:
            k = event_key(ev)
            if k in self.event_keys:
                continue
            self.event_keys.add(k)
            self.events += 1
            new += 1
            rec = dict(ev)
            rec["_gameTime"] = ((snap.get("gameData") or {}).get("gameTime"))
            rec["_snap"] = name
            self._append("lcda/events.jsonl", json.dumps(rec, ensure_ascii=False))
        return True

    def lcda_truth(self):
        try:
            return lf._truth_from_lcda(lcda_all().get("allPlayers"))
        except Exception:
            return None

    def lcda_game_time(self):
        try:
            return float(((lcda_all().get("gameData")) or {}).get("gameTime", 0) or 0)
        except Exception:
            return None

    # --------------------------------------------------------- observer ----
    def record_chunkinfo(self, lci):
        s = json.dumps(lci, sort_keys=True)
        if s == self.last_chunkinfo:
            return
        self.last_chunkinfo = s
        self._append("chunkinfo.jsonl", json.dumps(
            {"wall": time.time(), "lci": lci}, ensure_ascii=False))

    def pull_chunks(self, obs, latest):
        if latest is None:
            return
        limit = int(latest)
        pulled = 0
        while self.next_chunk <= limit and pulled < 50:
            cid = self.next_chunk
            try:
                raw = obs._get("/getChunkByChunkId/%s/%s/%d/token"
                               % (obs.platform, obs.game_id, cid))
            except Exception:
                break   # not available yet; retry next round
            with open(os.path.join(self.dirs["chunks"], "chunk_%05d.bin" % cid), "wb") as f:
                f.write(raw)
            self.next_chunk += 1
            pulled += 1

    def pull_keyframe(self, obs, kfid):
        kfid = int(kfid)
        if kfid in self.kf_seen:
            return
        self.kf_seen.add(kfid)
        raw = obs._get("/getKeyFrameById/%s/%s/%d/token"
                       % (obs.platform, obs.game_id, kfid))
        with open(os.path.join(self.dirs["kf"], "kf_%04d.bin" % kfid), "wb") as f:
            f.write(raw)
        dec = inflate(obs.bf.decrypt_ecb(raw))
        with open(os.path.join(self.dirs["kf"], "kf_%04d.dec" % kfid), "wb") as f:
            f.write(dec)
        det, blocks = extract_blocks(dec)
        truth = self.lcda_truth()
        t = self.lcda_game_time()
        if blocks:
            for order, pay in enumerate(blocks):
                self.stat_rows += 1
                self._append("statblocks.jsonl", json.dumps({
                    "t": t, "pid1": order + 1, "order": order,
                    "kfId": kfid, "op": det[0] if det else None,
                    "payload": pay.hex(), "truth": (truth[order] if truth else None),
                }, ensure_ascii=False))
        print("[capture] kf=%d dec=%dB blocks=%d truth=%s t=%s"
              % (kfid, len(dec), len(blocks), bool(truth), t))


def elevated_dump():
    """Pop one UAC prompt; the elevated helper writes cmdline (+lockfile) copies."""
    if not os.path.exists(DUMP_KEY_PS1):
        print("[elevate] helper missing:", DUMP_KEY_PS1)
        return False
    cmd = ["powershell", "-NoProfile", "-Command",
           "Start-Process powershell -Verb RunAs -Wait -ArgumentList "
           "'-NoProfile -ExecutionPolicy Bypass -File \"%s\"'" % DUMP_KEY_PS1]
    try:
        subprocess.run(cmd, timeout=180)
    except Exception as e:
        print("[elevate] failed:", e)
        return False
    ok = os.path.exists(ELEVATED_KEY_FILE)
    print("[elevate] key file:", ok, ELEVATED_KEY_FILE)
    return ok


def elevated_key_candidates():
    out = []
    try:
        txt = open(ELEVATED_KEY_FILE, encoding="utf-8-sig").read()
        out.extend(txt.splitlines())
    except OSError:
        pass
    return [l.strip() for l in out if len(l.strip()) > 20]


def discover_forever(rec, overrides, hz, elevate):
    """Resolve key/gameId/platform while LCDA is up; None -> stay lcda-only."""
    deadline = time.time() + DISCOVERY_GIVEUP_S
    prompted = False
    cmd = None
    while time.time() < deadline:
        if elevate and not prompted:
            elevated_dump()
            prompted = True
        cmd = _game_cmdline_quiet()
        lines = [cmd]
        if os.path.exists(ELEVATED_KEY_FILE):
            lines.extend(elevated_key_candidates())
        for line in lines:
            if not line:
                continue
            parsed = parse_cmdline(line)
            if "key" in parsed:
                if overrides.get("host"):
                    parsed["host"] = overrides["host"]
                elif "host" not in parsed:
                    h = _parse_host(line)
                    if h:
                        parsed["host"] = h
                return parsed, line
        time.sleep(5)
    return None, cmd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"C:/Temp/obs-live")
    ap.add_argument("--hz", type=float, default=1.0, help="LCDA poll rate")
    ap.add_argument("--elevate", action="store_true", help="pop one UAC prompt to dump the game key")
    ap.add_argument("--host"); ap.add_argument("--port", type=int, default=8088)
    ap.add_argument("--platform"); ap.add_argument("--game-id"); ap.add_argument("--key")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        raise SystemExit(0 if selftest() else 1)

    overrides = {k: v for k, v in (("host", args.host), ("port", args.port),
                                   ("platform", args.platform),
                                   ("gameId", args.game_id), ("key", args.key)) if v}
    rec = Recorder(args.out)

    print("[capture] waiting for LCDA (open a spectated game)...")
    rec.setup_dirs("pending")
    while not rec.poll_lcda():
        time.sleep(2)
    print("[capture] LCDA connected; recording ground truth.")

    disc = None
    if overrides.get("key") and overrides.get("gameId"):
        disc = dict(overrides)
    else:
        disc, cmdline = discover_forever(rec, overrides, args.hz, args.elevate)

    obs = None
    if disc and "key" in disc and "gameId" in disc:
        # validate platform candidates with a real metadata probe
        base_dir_guess = str(disc["gameId"])
        rec.setup_dirs(base_dir_guess)
        rec.manifest(source="live", gameId=disc["gameId"],
                     key=disc["key"], mode="pending-platform")
        for plat in platform_candidates(cmdline_for_candidates(disc), overrides):
            hosts = []
            if disc.get("host"):
                hosts.append(disc["host"])
            hosts.append("_spectator.%s.lol.riotgames.com" % plat.lower())
            for host in hosts:
                try:
                    cand = Observer(host, disc.get("port", 8088),
                                    plat, disc["gameId"], disc["key"])
                    meta = cand.metadata()
                    obs = cand
                    rec.info = {"host": host, "port": disc.get("port", 8088),
                                "platform": plat, "gameId": disc["gameId"],
                                "key": disc["key"]}
                    rec.manifest(mode="full", platform=plat,
                                 metadata=meta, host=host)
                    print("[capture] observer OK: host=%s platform=%s meta keys=%d"
                          % (host, plat, len(meta or {})))
                    break
                except Exception as e:
                    print("[capture] probe %s@%s: %s" % (plat, host, repr(e)[:120]))
            if obs is not None:
                break
    if obs is None:
        rec.manifest(mode="lcda-only", reason="key/gameId/platform unresolved")
        print("[capture] MODE=lcda-only (no observer). Truth+events still recorded.")
        print("[capture] to unlock full capture: run with --elevate (one UAC prompt),")
        print("[capture]   or pass --key/--game-id/--platform manually.")

    last_disc_poll = 0.0
    while True:
        ok = False
        try:
            ok = rec.poll_lcda()
        except Exception:
            pass
        if ok and obs is not None:
            try:
                lci = obs.last_chunk_info(0)
                rec.record_chunkinfo(lci)
                rec.pull_chunks(obs, lci.get("chunkId"))
                kfid = lci.get("keyFrameId") or lci.get("keyframeId")
                if kfid is not None:
                    rec.pull_keyframe(obs, kfid)
            except Exception as e:
                print("[capture] observer error:", repr(e)[:160])
        # keep retrying discovery in lcda-only mode (key may appear later)
        if obs is None and time.time() - last_disc_poll > 15:
            last_disc_poll = time.time()
            try:
                disc2, cmdline2 = discover_forever(rec, overrides, args.hz, False)
            except Exception:
                disc2 = None
            if disc2 and "key" in disc2 and "gameId" in disc2:
                print("[capture] late key discovery: retrying full mode")
                try:
                    obs = Observer(disc2.get("host") or "spectator.lol.riotgames.com",
                                   disc2.get("port", 8088), overrides.get("platform") or "NJ100",
                                   disc2["gameId"], disc2["key"])
                    obs.metadata()
                    rec.info.update(disc2)
                    rec.manifest(mode="full-late", **disc2)
                except Exception as e:
                    obs = None
                    print("[capture] late observer failed:", repr(e)[:120])
        if rec.lcda_ever_ok and rec.last_lcda_ok and \
                time.time() - rec.last_lcda_ok > LCDA_TIMEOUT_S:
            print("[capture] LCDA silent %ds -> game over, wrapping up" % LCDA_TIMEOUT_S)
            break
        time.sleep(args.hz)

    rec.manifest(finished=True)
    print("[capture] DONE:", rec.dirs["base"],
          json.dumps({"snaps": rec.snap_count, "events": rec.events,
                      "statRows": rec.stat_rows, "keyframes": len(rec.kf_seen)}))


def cmdline_for_candidates(disc):
    line = ""
    try:
        line = open(".tmp/live-cmdline.txt", encoding="utf-8").read()
    except OSError:
        try:
            line = open(ELEVATED_KEY_FILE, encoding="utf-8-sig").read()
        except OSError:
            pass
    return line


def selftest():
    import tempfile
    ok1 = lf.selftest()   # blowfish vectors + anchor/extract + solver live-sim
    rec = Recorder(tempfile.mkdtemp(prefix="cap-test-"))
    rec.setup_dirs("TESTGAME")
    rec.manifest(mode="test", gameId="TESTGAME")
    # event dedup
    ev = {"EventName": "DragonKill", "KillerName": "x", "DragonType": "Air"}
    k = event_key(ev)
    rec.event_keys.add(k)
    dup = event_key(dict(ev, AssistingUnitNames=None))
    ok2 = dup == k and event_key(dict(ev, KillerName="y")) != k
    # statblocks row is loadable by the offline decoder schema
    row = {"t": 1.0, "pid1": 1, "order": 0, "kfId": 1, "payload": "ab" * 8}
    rec._append("statblocks.jsonl", json.dumps(row))
    import decode_statblocks as dsb
    times, by_t = dsb.load_blocks(os.path.join(rec.dirs["base"], "statblocks.jsonl"))
    ok3 = times == [1.0] and by_t[1.0][0] == bytes.fromhex("ab" * 8)
    rec.manifest(finished=True)
    ok4 = json.load(open(os.path.join(rec.dirs["base"], "manifest.json")))["finished"]
    print("event dedup:", ok2, "schema compat:", ok3, "manifest:", ok4)
    verdict = bool(ok1) and ok2 and ok3 and ok4
    print("SELFTEST", "PASS" if verdict else "FAIL")
    return verdict


if __name__ == "__main__":
    main()
