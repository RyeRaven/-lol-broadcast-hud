"""Replay-mode 0xdd feeder: LCDA-synced protocol-feed from a v12 decode report.

A ROFL replay has no observer REST stream, so gold/xp come from the offline decode
report (decode_statblocks.py -> .tmp/decode_<game>.json) posted in lockstep with
the replay client's Live Client Data (127.0.0.1:2999) playback position.

Usage:
  python tools/decode0dd/replay_feed.py --game NJ100-901131919780
      [--url http://127.0.0.1:3314/api/protocol-feed] [--dry-run] [--at SECONDS]

Policy: values the report could not solve stay null; precision per field comes
from the report's own verification metrics (u8 bijection mismatches=0 -> exact;
f32 floor-exact with sub-unit drift -> estimated). Between keyframes the last
decoded frame is re-posted with its true asOf, never interpolated.
"""
import argparse
import bisect
import io
import json
import ssl
import time
import urllib.request

# LCDA 是带自签证书的 TLS 服务（http 裸请求会挂起）：必须走 https 并跳过校验。
LCDA = "https://127.0.0.1:2999"
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

def _get_json(url, timeout=3):
    return _read_json(urllib.request.urlopen(url, timeout=timeout, context=_SSL_CTX))

def get_json(url, timeout=3):
    return _get_json(url, timeout=timeout)

def _read_json(r):
    with r:
        return json.loads(r.read().decode("utf-8", "replace"))

def field_precision(meta):
    if meta.get("type") == "u8-bijection":
        return "exact" if meta.get("mismatches") == 0 else "estimated"
    total = meta.get("total") or 0
    if not total:
        return "estimated"
    if meta.get("exact") == total:
        return "exact"
    # f32 残差解码带亚单位漂移（本局 maxErr<=0.007），但整局逐样本 floor 都对得上
    # 官方 timeline（floorOk==total 且 within1==total）：喂给 HUD 的是 floor 后的整数，
    # 这个整数值是整局逐帧验证过的精确值，可以诚实标 exact；否则退回 estimated。
    if meta.get("floorOk") == total and meta.get("within1") == total:
        return "exact"
    return "estimated"

def build_payload(report, game_time, champs):
    times = report["times"]
    fi = bisect.bisect_right(times, game_time) - 1
    if fi < 0:
        return None
    as_of = times[fi]
    fields = report["fields"]
    prec = dict((name, field_precision(meta)) for name, meta in fields.items())

    def val(name, i):
        s = fields.get(name, {}).get("series")
        if not s or fi >= len(s):
            return None
        v = s[fi][i]
        return None if v is None else max(0, int(v))

    players = []
    for i in range(10):
        players.append({
            "participantId": i + 1,
            "team": "blue" if i < 5 else "red",
            "championName": champs.get(i),
            "kills": val("kills", i), "deaths": val("deaths", i),
            "assists": val("assists", i),
            "cs": val("minionsKilled", i),
            "totalGold": val("totalGold", i),
            "xp": val("xp", i),
            "asOf": as_of,
            "precision": {
                "kills": prec["kills"], "deaths": prec["deaths"],
                "assists": prec["assists"],
                "cs": prec["minionsKilled"],
                "totalGold": prec["totalGold"],
                "xp": prec["xp"],
            },
        })
    return {"source": "corpus", "gameId": report.get("game"),
            "gameTime": game_time, "updatedAt": int(time.time() * 1000),
            "players": players}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--report", default="")
    ap.add_argument("--url", default="http://127.0.0.1:3314/api/protocol-feed")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--at", type=float, default=None,
                    help="offline test: fixed playback time in seconds")
    args = ap.parse_args()
    report_path = args.report or ".tmp/decode_%s.json" % args.game
    with io.open(report_path, encoding="utf-8") as f:
        report = json.load(f)
    times = report["times"]
    print("[replay-feed] report %s frames=%d span=%.1fs" %
          (report_path, len(times), (times[-1] or 0) - (times[0] or 0)), flush=True)
    champs = {}
    started = time.time()
    last_lcda_ok = None
    while True:
        game_time = None
        try:
            # 该客户端只认 /liveclientdata/allgamedata（/gameData 返回 404 Invalid URI format）
            gd = get_json(LCDA + "/liveclientdata/allgamedata")
            game_time = float((gd.get("gameData") or {}).get("gameTime") or 0)
            last_lcda_ok = time.time()
            if not champs:
                champs = dict((i, (p.get("championName") or None))
                              for i, p in enumerate(gd.get("allPlayers") or []))
        except Exception:
            pass
        if args.at is not None:
            game_time = args.at
        if game_time is not None:
            payload = build_payload(report, game_time, champs)
            if payload:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                if args.dry_run:
                    p0 = payload["players"][0]
                    print("[dry] t=%.1f asOf=%.1f p0 kills=%s cs=%s xp=%s gold=%s prec=%s"
                          % (game_time, p0["asOf"], p0["kills"], p0["cs"], p0["xp"],
                             p0["totalGold"], json.dumps(p0["precision"])), flush=True)
                else:
                    try:
                        req = urllib.request.Request(args.url, data=body,
                                                     headers={"Content-Type": "application/json"})
                        urllib.request.urlopen(req, timeout=5)
                    except Exception as e:
                        print("[replay-feed] post failed:", e, flush=True)
        if args.at is not None:
            break
        if last_lcda_ok is None:
            if int(time.time() - started) % 15 == 0:
                print("[replay-feed] waiting for Live Client Data (2999) ...", flush=True)
        elif time.time() - last_lcda_ok > 60:
            raise SystemExit("[replay-feed] Live Client Data lost for 60s - exit")
        time.sleep(1.0)

if __name__ == "__main__":
    main()
