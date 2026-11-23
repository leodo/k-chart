"""把 dump_lines.mjs 导出的 K 线 + 自动线画成 PNG，用于人工比对（纯标准库，不需要 matplotlib）。

用法:
    .venv\\Scripts\\python.exe scripts\\render_check.py scripts\\lines_before.json scripts\\before.png
"""
from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

BG = (13, 17, 23)
GRID = (27, 37, 49)
UP = (240, 81, 90)
DOWN = (46, 184, 124)
TEXT = (215, 224, 234)
PAD_COLORS = [
    (76, 154, 255), (199, 146, 234), (0, 188, 212), (255, 179, 0),
]


class Canvas:
    def __init__(self, w: int, h: int) -> None:
        self.w, self.h = w, h
        self.buf = bytearray(BG * (w * h))

    def px(self, x: int, y: int, c: tuple[int, int, int], alpha: float = 1.0) -> None:
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        i = (y * self.w + x) * 3
        if alpha >= 0.999:
            self.buf[i:i + 3] = bytes(c)
        else:
            for k in range(3):
                self.buf[i + k] = int(self.buf[i + k] * (1 - alpha) + c[k] * alpha)

    def line(self, x0: float, y0: float, x1: float, y1: float, c, width: float = 1.4) -> None:
        dx, dy = x1 - x0, y1 - y0
        n = int(max(abs(dx), abs(dy))) + 1
        r = max(0.6, width / 2)
        steps = max(1, int(max(abs(dx), abs(dy)) * 2))
        for s in range(steps + 1):
            t = s / steps
            x, y = x0 + dx * t, y0 + dy * t
            for ox in range(-int(r), int(r) + 1):
                for oy in range(-int(r), int(r) + 1):
                    if ox * ox + oy * oy <= r * r + 0.2:
                        self.px(int(round(x)) + ox, int(round(y)) + oy, c)
        _ = n

    def rect(self, x0, y0, x1, y1, c) -> None:
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                self.px(x, y, c)

    def circle(self, x: float, y: float, r: float, c) -> None:
        for a in range(0, 360, 6):
            import math
            self.px(int(round(x + math.cos(a * math.pi / 180) * r)),
                    int(round(y + math.sin(a * math.pi / 180) * r)), c)

    def png(self, path: Path) -> None:
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)
            raw += self.buf[y * self.w * 3:(y + 1) * self.w * 3]

        def chunk(tag: bytes, data: bytes) -> bytes:
            return (struct.pack(">I", len(data)) + tag + data
                    + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)
        path.write_bytes(sig + chunk(b"IHDR", ihdr)
                         + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                         + chunk(b"IEND", b""))


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    data = json.loads(src.read_text(encoding="utf-8"))
    bars = data["bars"]
    lines = data["lines"]
    visible = int(data.get("visible") or 130)

    W, H = 1200, 700
    left, right, top, bottom = 0, 70, 10, 30
    cv = Canvas(W, H)
    n = len(bars)
    start = max(0, n - visible)
    end = n - 1
    end_draw = end + 12
    span = max(1, end_draw - start)
    bw = (W - left - right) / span

    def x_of(i: float) -> float:
        return left + (i - start + 0.5) * bw

    lo, hi = 1e18, -1e18
    for i in range(start, end + 1):
        lo = min(lo, bars[i]["low"])
        hi = max(hi, bars[i]["high"])
    for ln in lines:
        for i in range(start, min(end_draw, len(ln["values"]) - 1) + 1):
            v = ln["values"][i]
            if v is not None:
                lo, hi = min(lo, v), max(hi, v)
    pad = max((hi - lo) * 0.08, hi * 0.001)
    lo, hi = lo - pad, hi + pad

    def y_of(p: float) -> float:
        return top + (hi - p) / (hi - lo) * (H - top - bottom)

    for k in range(1, 8):
        y = top + (H - top - bottom) * k / 8
        cv.line(left, y, W - right, y, GRID)
    for i in range(start, end + 1, 10):
        cv.line(x_of(i), top, x_of(i), H - bottom, GRID)

    for i in range(start, end + 1):
        b = bars[i]
        c = UP if b["close"] >= b["open"] else DOWN
        x = x_of(i)
        cv.line(x, y_of(b["high"]), x, y_of(b["low"]), c, 1.0)
        cv.rect(x - bw * 0.3, min(y_of(b["open"]), y_of(b["close"])),
                x + bw * 0.3, max(y_of(b["open"]), y_of(b["close"])), c)

    # 自动线：颜色按 support id 轮换，major 用暖色
    major_palette = [(255, 107, 74), (240, 81, 90), (255, 152, 0), (233, 30, 99)]
    sup_palette = [(76, 154, 255), (199, 146, 234), (0, 188, 212), (255, 179, 0)]
    for ln in lines:
        if ln["key"] == "mid":
            continue
        pal = major_palette if ln["major"] else sup_palette
        color = pal[ln["id"] % len(pal)]
        if ln["key"] in ("lower",):
            color = (46, 184, 124) if not ln["major"] else (255, 154, 92)
        if ln["key"] in ("upper",):
            color = (240, 81, 90) if not ln["major"] else (255, 107, 74)
        pts = [(x_of(i), y_of(ln["values"][i]))
               for i in range(max(0, start), min(len(ln["values"]), end_draw + 1))
               if ln["values"][i] is not None]
        for a, b in zip(pts, pts[1:]):
            cv.line(a[0], a[1], b[0], b[1], color, 1.6)
        for t in ln["touch"]:
            if t["i"] < start or t["i"] > end:
                continue
            cv.circle(x_of(t["i"]), y_of(t["v"]), 4, color)

    cv.png(out)
    print(f"wrote {out} lines={len(lines)} bars={n} visible={visible} range=[{lo:.2f},{hi:.2f}]")


if __name__ == "__main__":
    main()
