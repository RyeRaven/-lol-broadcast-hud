# -*- coding: utf-8 -*-
"""hp_bars.py — 同机像素读条进程（百分比方案，t24）。

抓取对象 = 原生观战 HUD **屏幕左右两侧的队伍边栏**：
每侧 5 个玩家框，自上而下 rowIndex 0..4，每框两根条：
  - 血条（绿→黄→红随血量渐变，受损残影为暗红段，护盾为亮白段）
  - 资源条（法力蓝 / 能量黄 / 怒气红…紧贴血条正下方同宽；无资源英雄该条缺席）
两侧条都从容器左缘向右填充（6:09 参考图实测：红侧绿段起点固定、终点随血量变化）。
1920x1080 基准几何：行距 ~103.3px、血条高 ~7px、容器宽 ~42px、蓝侧 x≈31、红侧 x≈1847。

截屏 = OBS WebSocket GetSourceScreenshot（游戏采集源，钩子级、切屏免疫，
唯一要求游戏窗口不最小化）。几何每帧自动重标定（行锚点取绿段起点中位数），
另存 calib-state.json 兜底。输出契约 = src/pixel-bars.js 的 POST /api/pixel-bars：
  {source:'pixel', bars:[{side, rowIndex, kind:'hp'|'resource',
    fillPercent 0..100|null, status:'ok'|'absent'|'unsupported', shieldPx, dominantColor}]}
绝不伪造数值：读不到就 absent / null。

用法：
  python hp_bars.py --selftest                # 离线合成帧自测（不需要 OBS/游戏）
  python hp_bars.py --once --dump out.png     # 抓一帧、检测、POST 一次、落标注图
  python hp_bars.py                           # 10Hz 主循环（源自动探测 game_capture）
"""

import argparse
import base64
import hashlib
import io
import json
import os
import secrets
import socket
import struct
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
CALIB_PATH = os.path.join(HERE, "calib-state.json")

# 1920x1080 基准几何（6:09 参考图实测），按帧分辨率等比缩放做先验
BASE = {"pitch": 103.3, "row0_y": 206.0, "hp_h": 7.0, "bar_w": 42.0, "blue_x0": 31.0, "red_x0": 1847.0,
        "res_h": 6.0, "res_gap": 2.0}
FULL_PX_REF = 38.0  # 与 src/pixel-bars.js PIXEL_BAR_FULL_PX 一致：shieldPx 归一到此宽度

# ---------------------------------------------------------------- WebSocket (RFC6455 最小客户端)

class WsError(Exception):
    pass


class ObsWs:
    """obs-websocket v5 最小客户端。"""

    def __init__(self, host="127.0.0.1", port=4455, password=""):
        self.host = host
        self.port = port
        self.password = password
        self.sock = None
        self._seq = 0
        self._buf = b""

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=10)
        self.sock.settimeout(10)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        req = (
            "GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
            % (self.host, self.port, key)
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WsError("handshake closed")
            resp += chunk
        head, _, rest = resp.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise WsError("handshake refused: " + head.split(b"\r\n")[0].decode(errors="replace"))
        self._buf = rest
        self._identify()

    def _identify(self):
        hello = self.recv_json()
        d = hello.get("d", {})
        ident = {"rpcVersion": 1}
        if d.get("authentication"):
            salt = d.get("salt", "")
            challenge = d.get("challenge", "")
            first = base64.b64encode(hashlib.sha256((self.password + salt).encode()).digest()).decode()
            second = base64.b64encode(hashlib.sha256((first + challenge).encode()).digest()).decode()
            ident["authentication"] = second
        self.send_json({"op": 1, "d": ident})
        while True:
            msg = self.recv_json()
            if msg.get("op") == 2:
                return

    def _send_frame(self, payload, opcode=0x1):
        mask = secrets.token_bytes(4)
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WsError("socket closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _read_frame(self):
        b1, b2 = self._recv_exact(2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            (n,) = struct.unpack("!H", self._recv_exact(2))
        elif n == 127:
            (n,) = struct.unpack("!Q", self._recv_exact(8))
        return fin, opcode, self._recv_exact(n)

    def recv_message(self):
        frags = []
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:
                self._send_frame(payload, opcode=0xA)
                continue
            if opcode == 0x8:
                raise WsError("server close frame")
            if opcode in (0x1, 0x2):
                frags = [payload]
            elif opcode == 0x0 and frags:
                frags.append(payload)
            else:
                continue
            if fin:
                return b"".join(frags).decode("utf-8", errors="replace")

    def send_json(self, obj):
        self._send_frame(json.dumps(obj).encode("utf-8"), opcode=0x1)

    def recv_json(self):
        return json.loads(self.recv_message())

    def call(self, requestType, requestData=None, timeout=15.0):
        self._seq += 1
        rid = "px%d" % self._seq
        self.send_json({"op": 6, "d": {"requestType": requestType, "requestId": rid,
                                       "requestData": requestData or {}}})
        deadline = time.time() + timeout
        self.sock.settimeout(max(0.5, deadline - time.time()))
        while time.time() < deadline:
            msg = self.recv_json()
            d = msg.get("d", {})
            if msg.get("op") == 7 and d.get("requestId") == rid:
                st = d.get("requestStatus", {})
                if not st.get("result"):
                    raise WsError("%s failed: %s %s" % (requestType, st.get("code"), st.get("comment")))
                return d.get("responseData") or {}
        raise WsError("%s timeout" % requestType)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def find_game_source(obs, hint=None):
    inputs = obs.call("GetInputList", {}).get("inputs", [])
    games = [i["inputName"] for i in inputs if i.get("inputKind") == "game_capture"]
    if hint:
        return hint
    if games:
        return games[0]
    raise WsError("没有 game_capture 输入源，OBS 里先建游戏采集")


def grab_frame(obs, sourceName):
    resp = obs.call("GetSourceScreenshot",
                    {"sourceName": sourceName, "imageFormat": "png"}, timeout=20)
    b64 = resp.get("imageImageData") or resp.get("imageData")
    if not b64:
        raise WsError("截图响应缺图像字段: %s" % sorted(resp.keys()))
    # 本机 OBS 返回的是 data URI：data:image/png;base64,....
    if "," in b64 and b64[:5] == "data:":
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    return np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"))


# ---------------------------------------------------------------- 分色

def masks(a):
    r = a[:, :, 0].astype(np.int16)
    g = a[:, :, 1].astype(np.int16)
    b = a[:, :, 2].astype(np.int16)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = mx - mn
    bright = (r + g + b) / 3.0
    green = (g - r > 40) & (g - b > 40) & (g > 60)
    # 血量填充：亮的高饱和暖色（绿→黄→橙→红渐变都算，蓝色 mana 不算）
    hpfill = (sat > 50) & (bright > 100) & (b <= g + 30)
    # 受损残影：暗红（暗、r 主导）
    trail = (r - g > 50) & (r - b > 50) & (g < 80) & (bright <= 110)
    # 护盾：亮白/浅灰
    shield = (bright > 150) & (sat < 35)
    # 资源填充：高饱和彩色（含蓝 mana、黄能量、亮红怒气），排除暗红残影
    resfill = (sat > 45) & ((r + g + b) > 150) & ~trail
    return {"green": green, "hpfill": hpfill, "trail": trail, "shield": shield,
            "resfill": resfill, "sat": sat, "bright": bright}


def _bands(mask_1d, gap):
    idx = np.where(mask_1d)[0]
    out = []
    if not len(idx):
        return out
    s = p = idx[0]
    for v in idx[1:]:
        if v - p > gap:
            out.append((int(s), int(p)))
            s = v
        p = v
    out.append((int(s), int(p)))
    return out


# ---------------------------------------------------------------- 几何检测

def detect_side(frame, m, side):
    """在一侧 x-strip 里找 5 行血条。返回 rows=[{hp:(x0,x1,y0,y1), res:...}]。"""
    H, W = frame.shape[:2]
    s = W / 1920.0
    strip_w = int(160 * s)
    x0 = 0 if side == "blue" else W - strip_w
    strip = frame[:, x0:x0 + strip_w]
    ms = masks(strip)
    pitch = BASE["pitch"] * s
    tol = 6 * s
    # 候选带：逐行实心游程。现版原生 HUD 把血条画进卡片内部（与头像/名字/戒指同列同带），
    # 行带、列段都会被卡片艺术图合并——只有「从容器左缘起的连续实心段」能唯一标识条带行：
    # 头像行游程超宽、名字行有字形空洞、戒指弧在窗口右段留洞，全部过不了这道筛选。
    cand_mask = ms["green"] | ms["hpfill"] | ms["trail"] | ms["shield"]
    pl = (BASE["blue_x0"] if side == "blue" else BASE["red_x0"]) * s - x0
    bw = BASE["bar_w"] * s
    lo = int(max(0, pl - 6 * s))
    hi = int(min(strip_w, pl + bw + 6 * s))
    rows_raw = []
    for y in range(H):
        idx = np.flatnonzero(cand_mask[y, lo:hi])
        if idx.size == 0:
            continue
        # 游程起点 = 最贴近先验容器左缘的活动列；游程内不许有洞。
        # 游程之外窗口里还有活动没关系（名字/戒指/噪声），不参与本次判定。
        near = idx[np.abs(lo + idx - pl) <= 8 * s]
        if near.size == 0:
            continue
        # 起点取「最贴先验左缘」的活动列：噪声/杂散列可能更靠前但离先验更远
        v0 = int(near[int(np.argmin(np.abs(lo + near - pl)))])  # 列偏移值，不是 idx 下标！
        pos = int(np.searchsorted(idx, v0))
        run = 1
        while pos + run < idx.size and idx[pos + run] == v0 + run:
            run += 1
        if run < 3.5 * s or run > bw * 1.15:
            continue  # 太短=噪声，太长=头像整行
        rows_raw.append({"y0": y, "gx0": lo + v0, "gx1": lo + v0 + run - 1})
    # 相邻行合并成带（左右缘一致才合并；跨行漂移的是艺术图不是条）
    cands = []
    for c in rows_raw:
        if cands and c["y0"] - cands[-1]["y1"] <= 2 \
                and abs(c["gx0"] - cands[-1]["gx0"]) <= 3 \
                and abs(c["gx1"] - cands[-1]["gx1"]) <= 3:
            cands[-1]["y1"] = c["y0"]
        else:
            cands.append({"y0": c["y0"], "y1": c["y0"], "gx0": c["gx0"], "gx1": c["gx1"]})
    cands = [c for c in cands
             if 2.5 * s - 1 <= c["y1"] - c["y0"] + 1 <= 12 * s
             and 3 * s <= c["gx1"] - c["gx0"] + 1 <= bw * 1.1]
    if os.environ.get("HPB_DEBUG"):
        print("[%s] pl=%.1f cands=%s" % (side, pl, [(c["y0"], c["y1"], c["gx0"], c["gx1"]) for c in cands]))
    # 网格映射：行 k 的血条 y ≈ row0_y + k*pitch（先验锚定），槽位绝不漂移——
    # 杂散碎片过 k 范围、行距偏差、gx0 一致性三重过滤；空条槽位由网格补格。
    row0 = BASE["row0_y"] * s
    cand_bands = {}
    for c in cands:
        k = int(round((c["y0"] - row0) / pitch))
        if not (0 <= k <= 4):
            continue
        if abs(c["y0"] - (row0 + k * pitch)) > 10 * s:
            continue
        cur = cand_bands.get(k)
        if cur is None or abs(c["gx0"] - pl) < abs(cur["gx0"] - pl):
            cand_bands[k] = c
    if len(cand_bands) < 3:
        if os.environ.get("HPB_DEBUG"):
            print("[%s] grid slots<3: %s" % (side, sorted(cand_bands)))
        return []
    med_gx0 = int(np.median([c["gx0"] for c in cand_bands.values()]))
    keep = {k: c for k, c in cand_bands.items() if abs(c["gx0"] - med_gx0) <= 8 * s}
    if not keep:
        return []
    left = int(np.median([c["gx0"] for c in keep.values()]))
    if os.environ.get("HPB_DEBUG"):
        print("[%s] grid slots=%s" % (side, {k: (v["y0"], v["gx0"], v["gx1"]) for k, v in keep.items()}))
    # 容器宽：优先用血条上方的青灰描边行（满宽、与填充量无关），退回填充观测宽
    sr_ = strip[:, :, 0].astype(np.int16)
    sg_ = strip[:, :, 1].astype(np.int16)
    sb_ = strip[:, :, 2].astype(np.int16)
    bright_c = (sr_ + sg_ + sb_) / 3.0
    teal = (sg_ - sr_ > 25) & (sg_ - sb_ > 20) & (bright_c > 35) & (bright_c < 100)
    widths = []
    for c in keep.values():
        y_stop = max(0, c["y0"] - int(7 * s))
        seg_lo = max(0, c["gx0"] - 3)
        seg_hi = min(strip_w, c["gx0"] + int(bw) + 4)
        for y in range(c["y0"] - 1, y_stop - 1, -1):
            seg = np.flatnonzero(teal[y, seg_lo:seg_hi])
            if seg.size >= 20 * s:
                widths.append(int(seg[-1] - seg[0] + 1))
                break
    if widths:
        width = int(np.median(widths))
        width = int(min(max(width, bw * 0.8), bw * 1.4))
    else:
        width = max(c["gx1"] - c["gx0"] + 1 for c in keep.values())
        width = int(min(max(width, bw * 0.85), bw * 1.35))
    # 缺行补格：y0 - k*pitch 的中位数做网格基准
    base = int(np.median([c["y0"] - k * pitch for k, c in keep.items()]))
    out = []
    for k in range(5):
        c = keep.get(k)
        if c is not None:
            y0, y1 = c["y0"], c["y1"]
        else:
            y0 = int(round(base + k * pitch))
            y1 = y0 + max(2, int(round(BASE["hp_h"] * s))) - 1
        hp_rel = (left, left + width - 1, y0, y1)
        res = find_resource(strip, ms, hp_rel, x0, s)
        out.append({"hp": (x0 + left, x0 + left + width - 1, y0, y1), "res": res})
    return out


def find_resource(strip, ms, hp, x_off, s):
    """血条正下方同宽范围内的资源条带。返回 (x0,x1,y0,y1) 绝对坐标 或 None。"""
    hx0, hx1, hy0, hy1 = hp
    fm = ms["resfill"]
    y_a = hy1 + max(1, int(BASE["res_gap"] * s))
    y_b = min(hy1 + 2 + int((BASE["res_gap"] + BASE["res_h"]) * s) + int(4 * s), strip.shape[0])
    zone = fm[y_a:y_b, hx0:hx1 + 1]
    if zone.sum() < 6:
        return None
    rb = _bands(zone.any(axis=1), 1)
    if not rb:
        return None
    yy0, yy1 = rb[0]
    if yy1 - yy0 + 1 < 2 * s - 1:
        return None
    return (x_off + hx0, x_off + hx1, y_a + yy0, y_a + yy1)


def detect_geometry(frame):
    m = masks(frame)
    rows_out = []
    for side in ("blue", "red"):
        for i, r_ in enumerate(detect_side(frame, m, side)):
            rows_out.append({"side": side, "rowIndex": i, "hp": list(r_["hp"]), "res": list(r_["res"]) if r_["res"] else None})
    return rows_out


# ---------------------------------------------------------------- 单条读数

def read_hp(frame, rect):
    """读一条血条（双侧均左锚定）。返回 (fillPercent|None, shieldCols|None, status)。"""
    x0, x1, y0, y1 = rect
    if x1 - x0 < 3 or y1 - y0 < 2:
        return None, None, "absent"
    strip = frame[y0:y1 + 1, x0:x1 + 1]
    ms = masks(strip)
    width = strip.shape[1]
    # 实机血条绿偏暗（bright<100），hpfill 只覆盖亮暖色——绿色系并入填充判定
    fill = (ms["hpfill"] | ms["green"]) & ~ms["trail"]
    col_fill = fill.mean(axis=0) > 0.5
    col_shield = (ms["shield"] & ~fill).mean(axis=0) > 0.5
    col_trail = ms["trail"].mean(axis=0) > 0.4
    col_anybar = col_fill | col_shield | col_trail
    if not col_anybar.any():
        return None, None, "absent"
    nfill = 0
    for v in col_fill:
        if v:
            nfill += 1
        else:
            break
    nshield = 0
    for v in col_shield[nfill:]:
        if v:
            nshield += 1
        else:
            break
    pct = nfill / max(width, 1) * 100.0
    return round(pct, 1), nshield, "ok"


def read_resource(frame, rect):
    if not rect:
        return None, None, "absent"
    x0, x1, y0, y1 = rect
    strip = frame[y0:y1 + 1, x0:x1 + 1]
    ms = masks(strip)
    width = strip.shape[1]
    good = ms["resfill"]
    cols = good.mean(axis=0) > 0.5
    n = 0
    for v in cols:
        if v:
            n += 1
        else:
            break
    if n == 0:
        return None, None, "absent"
    sel = strip[good]
    color = [int(np.median(sel[:, k])) for k in range(3)] if len(sel) else None
    return round(n / max(width, 1) * 100.0, 1), color, "ok"


def read_all(frame, rows):
    bars = []
    for row in rows:
        side, idx = row["side"], row["rowIndex"]
        fill, shield, status = read_hp(frame, tuple(row["hp"]))
        shield_px = None
        if fill is not None and shield:
            wpx = (row["hp"][1] - row["hp"][0] + 1) or 1
            shield_px = shield * FULL_PX_REF / wpx
        bars.append({"side": side, "rowIndex": idx, "kind": "hp", "fillPercent": fill,
                     "status": status, "shieldPx": shield_px})
        rf, rcolor, rstatus = read_resource(frame, tuple(row["res"]) if row.get("res") else None)
        bars.append({"side": side, "rowIndex": idx, "kind": "resource", "fillPercent": rf,
                     "status": rstatus, "dominantColor": rcolor})
    return bars


# ---------------------------------------------------------------- EMA + POST

class Ema:
    def __init__(self, tau=0.25):
        self.tau = tau
        self.state = {}

    def smooth(self, key, value, now):
        if value is None:
            self.state.pop(key, None)
            return None
        prev, t0 = self.state.get(key, (None, None))
        if prev is None:
            self.state[key] = (value, now)
            return value
        dt = max(0.0, now - t0)
        alpha = 1.0 - pow(2.718281828, -dt / self.tau)
        out = prev + (value - prev) * alpha
        self.state[key] = (out, now)
        return out


def post_bars(port, bars):
    body = json.dumps({"source": "pixel", "bars": bars}).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/api/pixel-bars" % port, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read().decode())


def save_calib(rows):
    with open(CALIB_PATH, "w", encoding="utf-8") as f:
        json.dump({"updatedAt": time.time(), "rows": rows}, f, ensure_ascii=False, indent=1)


def load_calib():
    try:
        with open(CALIB_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("rows")
    except Exception:
        return None


# ---------------------------------------------------------------- 自测

def selftest():
    """合成 1920x1080 帧：两侧边栏 5 行、血条+资源条、含地图噪声。"""
    W, H = 1920, 1080
    img = Image.new("RGB", (W, H), (24, 30, 26))
    d = ImageDraw.Draw(img)
    # 地图噪声：条区附近放干扰色块
    d.rectangle([20, 190, 28, 400], fill=(40, 120, 50))
    d.rectangle([1890, 300, 1918, 460], fill=(40, 120, 50))
    truth = []
    pitch = 103.3
    hp_h = 7
    res_h = 6
    specs = {"blue": {"x0": 31, "w": 42}, "red": {"x0": 1847, "w": 40}}
    fills = [(0.92, 0.55), (0.35, 0.77), (1.0, 0.0), (0.62, 0.40), (0.10, 0.88)]
    for side in ("blue", "red"):
        x0 = specs[side]["x0"]
        w = specs[side]["w"]
        for i, (fh, fr) in enumerate(fills):
            y0 = int(203 + i * pitch)
            y1 = y0 + hp_h - 1
            fw = int(round(w * fh))
            d.rectangle([x0, y0, x0 + w - 1, y1], fill=(45, 45, 48))
            d.rectangle([x0, y0, x0 + fw - 1, y1], fill=(70, 200, 90) if fh > 0.5 else (200, 170, 40))
            # 行 1：护盾段
            if i == 1:
                d.rectangle([x0 + fw, y0, x0 + fw + 6, y1], fill=(205, 205, 210))
            ry0 = y1 + 2
            ry1 = ry0 + res_h - 1
            rw = int(round(w * fr))
            if rw > 0:
                d.rectangle([x0, ry0, x0 + rw - 1, ry1], fill=(55, 110, 220))
            truth.append({"side": side, "rowIndex": i, "fill": fh * 100, "shield": 6 if i == 1 else 0,
                          "res": fr * 100 if rw > 0 else None, "hp": [x0, x0 + w - 1, y0, y1],
                          "res_rect": [x0, x0 + w - 1, ry0, ry1] if rw > 0 else None})
    frame = np.asarray(img)
    Image.fromarray(frame).save(os.path.join(HERE, "..", "..", ".tmp", "selftest-frame.png"))
    rows = detect_geometry(frame)
    ok = len(rows) == 10
    if not ok:
        print("ROWS FAIL:", len(rows))
    tmap = {(t["side"], t["rowIndex"]): t for t in truth}
    for row in rows:
        t = tmap[(row["side"], row["rowIndex"])]
        geom_err = abs(row["hp"][0] - t["hp"][0]) + abs(row["hp"][1] - t["hp"][1]) + abs(row["hp"][2] - t["hp"][2])
        if geom_err > 6:
            print("GEOM FAIL", row["side"], row["rowIndex"], row["hp"], t["hp"]); ok = False
        fill, shield, status = read_hp(frame, tuple(row["hp"]))
        if fill is None:
            print("FILL NONE FAIL", row["side"], row["rowIndex"], status); ok = False
        elif abs(fill - t["fill"]) > 3:
            print("FILL FAIL", row["side"], row["rowIndex"], fill, t["fill"]); ok = False
        wpx = t["hp"][1] - t["hp"][0] + 1
        want = t["shield"] * FULL_PX_REF / wpx
        got = (shield * FULL_PX_REF / wpx) if shield else 0
        if abs(got - want) > 1:
            print("SHIELD FAIL", row["side"], row["rowIndex"], got, want); ok = False
        rf, rcolor, rstatus = read_resource(frame, tuple(row["res"]) if row.get("res") else None)
        want_res = t["res"]
        want_rect = t.get("res_rect")
        if want_res is None:
            if rstatus != "absent":
                print("RES ABSENT FAIL", row["side"], row["rowIndex"], rf, rstatus); ok = False
        elif rf is None or not want_rect:
            print("RES NULL FAIL", row["side"], row["rowIndex"], rstatus); ok = False
        elif abs(rf - want_res) > 4:
            print("RES FAIL", row["side"], row["rowIndex"], rf, want_res); ok = False
    bars = read_all(frame, rows)
    n = sum(1 for x in bars if x["fillPercent"] is not None)
    print("rows=%d bars=%d postable=%d" % (len(rows), len(bars), n))
    print("SELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--dump")
    ap.add_argument("--source")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port-obs", type=int, default=4455)
    ap.add_argument("--port-api", type=int, default=3314)
    ap.add_argument("--hz", type=float, default=10.0)
    ap.add_argument("--password", default="")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    obs = ObsWs(args.host, args.port_obs, args.password)
    obs.connect()
    src = find_game_source(obs, args.source)
    print("source:", src)

    rows = load_calib()

    def annotate(frame, rows_):
        im = Image.fromarray(frame)
        d = ImageDraw.Draw(im)
        for row in rows_:
            x0, x1, y0, y1 = row["hp"]
            d.rectangle([x0, y0, x1, y1], outline=(255, 220, 0))
            if row.get("res"):
                rx0, rx1, ry0, ry1 = row["res"]
                d.rectangle([rx0, ry0, rx1, ry1], outline=(0, 200, 255))
        im.save(args.dump)
        print("dumped", args.dump)

    if args.calibrate or args.once:
        try:
            frame = grab_frame(obs, src)
        except WsError as e:
            print("grab failed: %s（游戏采集源没有可渲染画面：游戏未开或窗口最小化）" % e)
            return
        if frame.mean() < 3:
            print("frame all black — 游戏画面没有输出（未开游戏/窗口最小化）")
            return
        rows = detect_geometry(frame)
        save_calib(rows)
        bars = read_all(frame, rows)
        print(json.dumps(bars, ensure_ascii=False))
        try:
            print("post:", post_bars(args.port_api, bars))
        except Exception as e:
            print("post failed:", e)
        if args.dump:
            annotate(frame, rows)
        return

    ema = Ema()
    tick = 1.0 / max(0.5, args.hz)
    while True:
        t0 = time.time()
        try:
            frame = grab_frame(obs, src)
        except Exception as e:
            print("grab error:", e)
            time.sleep(1)
            continue
        if frame.mean() < 3:
            print("all black — 暂停推送")
            time.sleep(1)
            continue
        try:
            rows_now = detect_geometry(frame)
            if rows_now:
                rows = rows_now
                save_calib(rows)
        except Exception:
            pass
        if not rows:
            print("no bars found yet")
            time.sleep(0.5)
            continue
        raw = read_all(frame, rows)
        now = time.time()
        out = []
        for x in raw:
            y = dict(x)
            key = ("hp" if x["kind"] == "hp" else "res") + ":%s:%d" % (x["side"], x["rowIndex"])
            y["fillPercent"] = ema.smooth(key, x["fillPercent"], now)
            out.append(y)
        try:
            post_bars(args.port_api, out)
        except Exception as e:
            print("post failed:", e)
        dt = time.time() - t0
        time.sleep(max(0.0, tick - dt))


if __name__ == "__main__":
    main()
