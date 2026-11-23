"""MOS 指标的独立参考实现（用 Python 逐条复刻通达信公式），用来和前端 mos.js 的标记对拍。

只用于开发校验，不参与运行。
用法: .venv\\Scripts\\python.exe scripts\\_mos_ref.py [period] [symbol] [limit]
"""
from __future__ import annotations

import json
import sys
import urllib.request

period = sys.argv[1] if len(sys.argv) > 1 else "1d"
symbol = sys.argv[2] if len(sys.argv) > 2 else "RBL9"
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 800

with urllib.request.urlopen(
    f"http://127.0.0.1:8765/api/bars?symbol={symbol}&period={period}&limit={limit}"
) as fh:
    bars = json.load(fh)["bars"]

O = [b["open"] for b in bars]
H = [b["high"] for b in bars]
L = [b["low"] for b in bars]
C = [b["close"] for b in bars]
n = len(C)


def ema_tdx(x, period_):
    out = [float("nan")] * len(x)
    prev = None
    for i, v in enumerate(x):
        prev = v if prev is None else (2 * v + (period_ - 1) * prev) / (period_ + 1)
        out[i] = prev
    return out


def sma_tdx(x, period_, m):
    out = [float("nan")] * len(x)
    prev = None
    for i, v in enumerate(x):
        prev = v if prev is None else (m * v + (period_ - m) * prev) / period_
        out[i] = prev
    return out


def bars_last(flags):
    out = []
    last = -1
    for i, f in enumerate(flags):
        if f:
            last = i
        out.append(i if last < 0 else i - last)
    return out


def ref_at(series, i, k):
    j = i - round(k)
    return series[j] if 0 <= j < len(series) else float("nan")


def cross_above(a, b, i):
    return i > 0 and a[i] > b[i] and a[i - 1] <= b[i - 1]


def intpart(x):
    return float(int(x)) if x == x else float("nan")


def mantissa(x, digits):
    if x != x or digits != digits:
        return float("nan")
    return intpart(x / (10 ** digits))


def digits_of(x):
    if x != x or x == 0:
        return float("nan")
    import math
    return intpart(math.log10(abs(x))) - 1


# ---- MACD（DIFF 乘 100） ----
ema12, ema26 = ema_tdx(C, 12), ema_tdx(C, 26)
DIFF = [100 * (a - b) for a, b in zip(ema12, ema26)]
DEA = ema_tdx(DIFF, 9)
MACD = [2 * (d - e) for d, e in zip(DIFF, DEA)]

death = [cross_above(DEA, DIFF, i) for i in range(n)]
gold = [cross_above(DIFF, DEA, i) for i in range(n)]
BL_D = bars_last(death)
BL_G = bars_last(gold)

# ---- 底部 ----
CL1 = [float("nan")] * n
CL2 = [float("nan")] * n
CL3 = [float("nan")] * n
DIFL1 = [float("nan")] * n
DIFL2 = [float("nan")] * n
DIFL3 = [float("nan")] * n
for i in range(n):
    w = BL_D[i] + 1
    CL1[i] = min(L[max(0, i - w + 1):i + 1])
    DIFL1[i] = min(DIFF[max(0, i - w + 1):i + 1])
    j1 = i - w
    if j1 >= 0:
        CL2[i] = CL1[j1]
        DIFL2[i] = DIFL1[j1]
        CL3[i] = CL2[j1]
        DIFL3[i] = DIFL2[j1]

direct_bottom = [False] * n
far_bottom = [False] * n
MDIFB2 = [float("nan")] * n
MDIFB3 = [float("nan")] * n
for i in range(n):
    pd2 = digits_of(DIFL2[i])
    mdifl2 = mantissa(DIFL2[i], pd2)
    mdifb2 = mantissa(DIFF[i], pd2)
    pd3 = digits_of(DIFL3[i])
    mdifl3 = mantissa(DIFL3[i], pd3)
    mdifb3 = mantissa(DIFF[i], pd3)
    MDIFB2[i], MDIFB3[i] = mdifb2, mdifb3
    prev_macd = MACD[i - 1] if i > 0 else float("nan")
    direct_bottom[i] = (CL1[i] < CL2[i] and mdifb2 > mdifl2 and DIFF[i] < 0
                        and MACD[i] < 0 and prev_macd < 0)
    far_bottom[i] = (CL1[i] < CL3[i] < CL2[i] and mdifb3 > mdifl3
                     and MACD[i] < 0 and prev_macd < 0)

BG = [False] * n
for i in range(2, n):
    a = MDIFB2[i] > MDIFB2[i - 1] and direct_bottom[i - 2]
    b = MDIFB3[i] > MDIFB3[i - 2] and far_bottom[i - 2]
    BG[i] = bool(a or b)

# FILTER(BG AND P, MACD>0)
bottom_sig = []
block = -1
for i in range(n):
    if not (BG[i] and cross_above(DIFF, DEA, i)):
        continue
    if i <= block:
        continue
    bottom_sig.append(i)
    block = i + (1 if MACD[i] > 0 else 0)

# ---- 顶部 ----
CH1 = [float("nan")] * n
CH2 = [float("nan")] * n
CH3 = [float("nan")] * n
DIFH1 = [float("nan")] * n
DIFH2 = [float("nan")] * n
DIFH3 = [float("nan")] * n
for i in range(n):
    w = BL_G[i] + 1
    CH1[i] = max(H[max(0, i - w + 1):i + 1])
    DIFH1[i] = max(DIFF[max(0, i - w + 1):i + 1])
    j1 = i - w
    if j1 >= 0:
        CH2[i] = CH1[j1]
        DIFH2[i] = DIFH1[j1]
        CH3[i] = CH2[j1]
        DIFH3[i] = DIFH2[j1]

direct_top = [False] * n
far_top = [False] * n
MDIFT2 = [float("nan")] * n
MDIFT3 = [float("nan")] * n
for i in range(n):
    pd2 = digits_of(DIFH2[i])
    mdifh2 = mantissa(DIFH2[i], pd2)
    mdift2 = mantissa(DIFF[i], pd2)
    pd3 = digits_of(DIFH3[i])
    mdifh3 = mantissa(DIFH3[i], pd3)
    mdift3 = mantissa(DIFF[i], pd3)
    MDIFT2[i], MDIFT3[i] = mdift2, mdift3
    prev_macd = MACD[i - 1] if i > 0 else float("nan")
    direct_top[i] = (CH1[i] > CH2[i] and mdift2 < mdifh2 and DIFF[i] > 0
                     and MACD[i] > 0 and prev_macd > 0)
    far_top[i] = (CH1[i] > CH3[i] > CH2[i] and mdift3 < mdifh3
                  and MACD[i] > 0 and prev_macd > 0)

TG = [False] * n
for i in range(2, n):
    a = MDIFT2[i] < MDIFT2[i - 1] and direct_top[i - 2]
    b = MDIFT3[i] < MDIFT3[i - 2] and far_top[i - 2]
    TG[i] = bool(a or b)

top_sig = []
block = -1
for i in range(n):
    if not (TG[i] and cross_above(DEA, DIFF, i)):
        continue
    if i <= block:
        continue
    top_sig.append(i)
    block = i + (1 if MACD[i] < 0 else 0)

# ---- 时间 / KDJ 低点 / TYX3 高点 ----
def extreme_at(series, w, i, pick_max):
    lo = max(0, i - w + 1)
    best, at = None, -1
    for j in range(lo, i + 1):
        if series[j] != series[j]:
            continue
        if at < 0 or (series[j] >= best if pick_max else series[j] <= best):
            best, at = series[j], j
    return at


def filtered(flags, period_):
    out = [False] * n
    block = -1
    for i in range(n):
        if not flags[i] or i <= block:
            continue
        out[i] = True
        block = i + period_
    return out


w1 = filtered([extreme_at(H, 13, i, True) == i for i in range(n)], 13)
w2 = filtered([extreme_at(L, 13, i, False) == i for i in range(n)], 13)

RSV = []
for i in range(n):
    lo = min(L[max(0, i - 8):i + 1])
    hi = max(H[max(0, i - 8):i + 1])
    RSV.append((C[i] - lo) / (hi - lo) * 100 if hi > lo else 0)
K = sma_tdx(RSV, 3, 1)
k_cross = [cross_above(K, RSV, i) for i in range(n)]
BL_K = bars_last(k_cross)
low_point = [BL_K[i] >= 3 and cross_above(RSV, K, i) and K[i] < 30 for i in range(n)]

TYX = [(C[i] + L[i] + O[i] + H[i]) / 4 for i in range(n)]
HHV30 = [max(TYX[max(0, i - 29):i + 1]) for i in range(n)]
TYX3 = [float("nan")] * n
for i in range(3, n):
    TYX3[i] = (HHV30[i - 3] + HHV30[i - 2] + HHV30[i - 1]) / 3
above5 = [i > 0 and all(C[j] > TYX3[j] for j in range(i - 4, i + 1)) for i in range(n)]
high_point = [i > 0 and above5[i - 1] and C[i] < TYX3[i] and C[i] < O[i] for i in range(n)]

result = json.dumps({
    "bars": n,
    "●底部结构": bottom_sig,
    "●顶部结构": top_sig,
    "时间": [i for i in range(n) if w1[i] or w2[i]],
    "▲低点": [i for i in range(n) if low_point[i]],
    "▲高点": [i for i in range(n) if high_point[i]],
}, ensure_ascii=False)

out_path = sys.argv[4] if len(sys.argv) > 4 else None
if out_path:
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(result)
else:
    print(result)
