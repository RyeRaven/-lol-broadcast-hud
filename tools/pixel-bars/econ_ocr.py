# -*- coding: utf-8 -*-
r"""econ_ocr.py — 同机屏幕经济面板 OCR（逐玩家总金币，真值）。

抓取对象 = 原生观战 HUD 底部的经济面板（X 面板）：每行白字「当前(总)」，
括号里的总金币与 LCU timeline 的 totalGold 真值逐格一致（2560x1440 实测十格全对）。
等级/CS 是黄字、赏金飘字是金色，白掩膜天然滤掉。

解析 = 结构锚点，不钉分辨率/坐标（软件要通用）：
  1) 白掩膜 (min(R,G,B)>150) & (max-min<45)
  2) XY-cut：屏幕下部列投影切段（容差 gap 保住 "107(1457)" 整簇）→ 段内行投影切行
     （相邻面板行共用 x 列被粘成大箱时靠行切拆开）→ 行内列投影切字形
  3) 整簇校验：全部字形 IoU>=0.30 且与次像分差>=0.08、拼成 ^\d+\(\d+\)$、
     括号高于全部数字、当前<=总 —— KDA 斜杠/OBS 杂点等杂簇天然被拒
  4) 字形 bbox 裁切 → 高 16 等比 → 居中 pad 16x12，与 digit_templates.npz 做 IoU 最近邻
  5) 簇中心 x < W/2 → blue，否则 red；每侧按 y 序取前 5 行 = rowIndex 0..4
输出契约 = src/econ-ocr.js 的 POST /api/econ-ocr：
  {source:'econ-ocr', rows:[{side, rowIndex, totalGold, confidence}]}
整帧没有可信面板 → 不上报（服务端 store 过 TTL 失效，HUD 回退估算并标「估算」）。
绝不伪造数值。

用法：
  python econ_ocr.py --selftest                # 模板库 LOOCV 自检
  python econ_ocr.py --image 截图.png          # 离线解析一张图，打印 JSON（不 POST）
  python econ_ocr.py --once --dump out.png     # OBS 抓一帧、解析、POST 一次、落标注图
  python econ_ocr.py                           # 1Hz 主循环（复用 hp_bars 的 OBS 客户端）
"""

import argparse
import json
import os
import re
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

from hp_bars import ObsWs, WsError, find_game_source, grab_frame, post_bars as _post_unused

HERE = os.path.dirname(os.path.abspath(__file__))
TPL_PATH = os.path.join(HERE, "digit_templates.npz")

NORM_H, NORM_W = 16, 12
MATCH_IOU = 0.30
MAX_GOLD = 999999
# 面板在屏幕下部：只搜下半段，避开顶部计分板。0.55 会扫到 OBS 自己的 UI 控件带（误报 387(1087)），
# 0.70 起点只覆盖 16:9 的 0.80-0.99 面板区并留余量，且已实测避开全部 OBS 杂带。
SEARCH_TOP_FRAC = 0.70
# XY-cut 列段容差：金币簇内数字间隙实测 <=6px，字段间 62/87px；
# 0.008H（1440p≈12px）能保住 "107(1457)" 整段不被并进 KDA 段。
COL_GAP_FRAC = 0.008
# 段内行切 gap：相邻面板行垂直间隙 12-24px（1440p），0.004H≈6px 足够拆开上下两行。
ROW_GAP_FRAC = 0.004
# 行段最小高度（字形太矮的是噪声）；1440p 字高 ~28px≈0.019H，取 0.012H 挡噪带。
MIN_ROW_FRAC = 0.012

_templates = None


def templates():
    global _templates
    if _templates is None:
        with np.load(TPL_PATH, allow_pickle=False) as z:
            _templates = (z["masks"].astype(bool), [str(x) for x in z["labels"]])
    return _templates


def white_mask(a):
    mn = a.min(axis=2)
    mx = a.max(axis=2)
    return (mn > 150) & ((mx - mn) < 45)


def glyph_boxes(mask, y0, y1, x0, x1, min_w=2):
    """列投影切字形，返回 (x0,y0,x1,y1) 列表（probe6 同款）。"""
    sub = mask[y0:y1, x0:x1]
    colp = sub.sum(axis=0)
    boxes = []
    in_c = False
    cx0 = 0
    for x, v in enumerate(colp):
        if v > 0 and not in_c:
            in_c = True
            cx0 = x
        elif v == 0 and in_c:
            in_c = False
            if x - cx0 >= min_w:
                boxes.append((cx0 + x0, x + x0))
    if in_c:
        boxes.append((cx0 + x0, len(colp) + x0))
    out = []
    for bx0, bx1 in boxes:
        band = mask[y0:y1, bx0:bx1]
        rows = np.where(band.sum(axis=1) > 0)[0]
        if len(rows) == 0:
            continue
        out.append((int(bx0), int(rows.min() + y0), int(bx1), int(rows.max() + y0 + 1)))
    return out


def normalize(crop):
    """bbox 裁切 → 高 16 等比 → 居中 pad 16x12（probe6 同款）。"""
    ys, xs = np.where(crop)
    if len(ys) == 0:
        return None
    g = crop[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8) * 255
    gh, gw = g.shape
    nw = max(1, min(NORM_W, int(round(gw * NORM_H / gh))))
    im = Image.fromarray(g).resize((nw, NORM_H), Image.BILINEAR)
    arr = np.asarray(im) > 127
    out = np.zeros((NORM_H, NORM_W), dtype=bool)
    x0 = (NORM_W - nw) // 2
    out[:, x0:x0 + nw] = arr
    return out


def classify(mask_crop):
    """IoU 最近邻：返回 (label, score, runner_up) 或 (None, 0, 0)。
    runner_up = 异标签里的最高分：贴的脸和第二像的脸差距太小就说明字形退化（发暗/粘连），
    调用方应该拒绝这一格，而不是拿一个低置信度的猜测冒充真值。"""
    nrm = normalize(mask_crop)
    if nrm is None:
        return None, 0.0, 0.0
    tm, tl = templates()
    best_lab, best_s, second = None, 0.0, 0.0
    for i in range(tm.shape[0]):
        inter = np.logical_and(nrm, tm[i]).sum()
        union = np.logical_or(nrm, tm[i]).sum()
        s = inter / union if union else 0.0
        if s > best_s:
            if best_lab is not None and tl[i] != best_lab:
                second = max(second, best_s)
            else:
                second = max(second, second)
            best_s, best_lab = s, tl[i]
        elif best_lab is not None and tl[i] != best_lab:
            second = max(second, s)
    return best_lab, best_s, second


def loocv():
    """模板库自检：留一交叉验证，全部字形应各自匹配到同标签。"""
    tm, tl = templates()
    correct = 0
    confusions = {}
    for k in range(tm.shape[0]):
        best_lab, best_s = None, -1.0
        for j in range(tm.shape[0]):
            if j == k:
                continue
            inter = np.logical_and(tm[k], tm[j]).sum()
            union = np.logical_or(tm[k], tm[j]).sum()
            s = inter / union if union else 0.0
            if s > best_s:
                best_s, best_lab = s, tl[j]
        if best_lab == tl[k]:
            correct += 1
        else:
            confusions[tl[k] + ">" + str(best_lab)] = confusions.get(tl[k] + ">" + str(best_lab), 0) + 1
    print("templates=%d LOOCV %d/%d" % (tm.shape[0], correct, tm.shape[0]))
    for key in sorted(confusions):
        print("  confusion", key, confusions[key])
    return 0 if not confusions and correct == tm.shape[0] else 1


def segments(proj, min_gap):
    """一维投影切段：值>0 的连续区段，空隙 >min_gap 时切开，返回 (s,e) 列表。"""
    idx = np.where(proj > 0)[0]
    if not len(idx):
        return []
    segs = []
    s = p = int(idx[0])
    for v in idx[1:]:
        v = int(v)
        if v - p > min_gap:
            segs.append((s, p + 1))
            s = v
        p = v
    segs.append((s, p + 1))
    return segs


GOLD_RE = re.compile(r"^(\d+)\((\d+)\)$")


# 同一 glyph 与次像标签的分差低于这个值 → 字形退化（暗字/粘连），整窗作废。
MATCH_MARGIN = 0.08


def cells(mask, y0, y1, x0, x1, H):
    """XY-cut：列投影切段（容差 gap 保住 N(M) 整簇）→ 段内行投影切行（拆开
    上下两行共用 x 列的粘连）→ 行内列投影切字形。返回 (glyphs, y0, y1, x0, x1)。"""
    col_gap = max(4, int(round(H * COL_GAP_FRAC)))
    row_gap = max(3, int(round(H * ROW_GAP_FRAC)))
    min_h = int(H * MIN_ROW_FRAC)
    out = []
    for (cx0, cx1) in segments(mask[y0:y1, x0:x1].sum(axis=0), col_gap):
        ax0, ax1 = cx0 + x0, cx1 + x0
        for (ry0, ry1) in segments(mask[y0:y1, ax0:ax1].sum(axis=1), row_gap):
            if ry1 - ry0 < min_h:
                continue
            ay0, ay1 = ry0 + y0, ry1 + y0
            g = glyph_boxes(mask, ay0, ay1, ax0, ax1)
            if g:
                out.append((g, ay0, ay1, ax0, ax1))
    return out


def scan_cell(glyphs, mask):
    """整簇校验：全部字形可信 + 拼成 N(M) + 括号高于全部数字 + 数值范围。
    返回 (hit, reason)；hit=None 时 reason 说明拒绝原因（debug 用）。"""
    n = len(glyphs)
    if n < 4 or n > 15:
        return None, "len=%d" % n
    labels, ious = [], []
    for b in glyphs:
        lab, sc, second = classify(mask[b[1]:b[3], b[0]:b[2]])
        if lab is None or sc < MATCH_IOU or (second > 0 and sc - second < MATCH_MARGIN):
            return None, "glyph %s iou=%.2f" % (lab, sc)
        labels.append(lab)
        ious.append(sc)
    text = "".join(labels)
    m = GOLD_RE.match(text)
    if not m:
        return None, "text=" + text
    ip, jp = text.index("("), text.index(")")
    hs = [b[3] - b[1] for b in glyphs]
    dig = max(hs[k] for k in range(len(hs)) if k not in (ip, jp))
    if hs[ip] <= dig or hs[jp] <= dig:
        return None, "paren %s" % hs
    cur, total = int(m.group(1)), int(m.group(2))
    if total > MAX_GOLD or cur > total:
        return None, "range " + text
    return {"text": text, "total": total, "conf": min(ious),
            "xc": (glyphs[0][0] + glyphs[-1][2]) / 2.0,
            "y0": glyphs[0][1], "y1": max(b[3] for b in glyphs)}, "ok"


def parse_frame(a):
    """一帧 RGB → rows:[{side,rowIndex,totalGold,confidence}]。无可信面板返回 []。"""
    H, W = a.shape[:2]
    mask = white_mask(a)
    found = []
    for g, ay0, ay1, ax0, ax1 in cells(mask, int(H * SEARCH_TOP_FRAC), H, 0, W, H):
        hit, _why = scan_cell(g, mask)
        if hit:
            hit["side"] = "blue" if hit["xc"] < W / 2 else "red"
            found.append(hit)
    out = []
    for side in ("blue", "red"):
        picked = sorted([r for r in found if r["side"] == side], key=lambda r: (r["y0"], r["xc"]))[:5]
        for i, r in enumerate(picked):
            out.append({"side": side, "rowIndex": i, "totalGold": r["total"], "confidence": round(float(r["conf"]), 3)})
    return out


def annotate(a, rows, path):
    """标注图：XY-cut 段框 + 可信行整簇框 + 行文本（debug 用）。"""
    im = Image.fromarray(a)
    d = ImageDraw.Draw(im)
    mask = white_mask(a)
    H, W = a.shape[:2]
    for g, ay0, ay1, ax0, ax1 in cells(mask, int(H * SEARCH_TOP_FRAC), H, 0, W, H):
        d.rectangle([ax0, ay0, ax1 - 1, ay1 - 1], outline=(255, 220, 0))
        hit, _why = scan_cell(g, mask)
        if hit:
            yb = max(b[3] for b in g)
            d.rectangle([g[0][0], g[0][1], g[-1][2] - 1, yb - 1], outline=(0, 255, 0))
    for r in rows:
        d.text((10, 10 + r["rowIndex"] * 18), "%s#%d %d conf=%.2f" % (r["side"], r["rowIndex"], r["totalGold"], r["confidence"]), fill=(0, 255, 0))
    im.save(path)
    print("dumped", path)


def post_econ(port, rows):
    import urllib.request
    body = json.dumps({"source": "econ-ocr", "rows": rows}).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/api/econ-ocr" % port, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--image")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dump")
    ap.add_argument("--source")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port-obs", type=int, default=4455)
    ap.add_argument("--port-api", type=int, default=3314)
    ap.add_argument("--hz", type=float, default=1.0)
    ap.add_argument("--password", default="")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(loocv())

    if args.image:
        a = np.asarray(Image.open(args.image).convert("RGB"))
        rows = parse_frame(a)
        print(json.dumps({"rows": rows}, ensure_ascii=False, indent=1))
        if args.dump:
            annotate(a, rows, args.dump)
        return

    obs = ObsWs(args.host, args.port_obs, args.password)
    obs.connect()
    src = find_game_source(obs, args.source)
    print("source:", src)

    def annotate_obs(frame, rows_):
        annotate(frame, rows_, args.dump)

    if args.once:
        try:
            frame = grab_frame(obs, src)
        except WsError as e:
            print("grab failed: %s（游戏采集源没有可渲染画面：游戏未开或窗口最小化）" % e)
            return
        if frame.mean() < 3:
            print("frame all black — 游戏画面没有输出（未开游戏/窗口最小化）")
            return
        rows = parse_frame(frame)
        print(json.dumps({"rows": rows}, ensure_ascii=False))
        try:
            print("post:", post_econ(args.port_api, rows))
        except Exception as e:
            print("post failed:", e)
        if args.dump:
            annotate_obs(frame, rows)
        return

    tick = 1.0 / max(0.2, args.hz)
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
        rows = parse_frame(frame)
        if rows:
            try:
                post_econ(args.port_api, rows)
            except Exception as e:
                print("post failed:", e)
        dt = time.time() - t0
        time.sleep(max(0.0, tick - dt))


if __name__ == "__main__":
    main()
