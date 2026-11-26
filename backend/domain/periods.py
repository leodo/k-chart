"""周期定义与交易时段感知的聚合。

设计要点：
- 原生周期直接映射通达信扩展行情 K 线类别；
- 4h 从 60m 聚合，1w 从日线聚合；
- 聚合按“交易分钟”计数，午休/夜盘断档不计时，避免按自然小时切错；
- 4h 按交易日切片，1w 按 ISO 自然周切片（周内跨交易日不提前收桶）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable, Sequence

from .models import Bar

NATIVE_CATEGORY = {
    "1m": 7,
    "5m": 0,
    "15m": 1,
    "30m": 2,
    "1h": 3,
    "1d": 4,
}


@dataclass(frozen=True, slots=True)
class PeriodSpec:
    name: str
    source: str            # 取数所用原生周期
    interval_minutes: int  # 源周期时长
    group_minutes: int = 0 # >0 表示需要聚合
    label: str = ""


PERIODS: dict[str, PeriodSpec] = {
    "1m": PeriodSpec("1m", "1m", 1, label="1分钟"),
    "5m": PeriodSpec("5m", "5m", 5, label="5分钟"),
    "15m": PeriodSpec("15m", "15m", 15, label="15分钟"),
    "30m": PeriodSpec("30m", "30m", 30, label="30分钟"),
    "1h": PeriodSpec("1h", "1h", 60, label="1小时"),
    "4h": PeriodSpec("4h", "1h", 60, 240, "4小时"),
    "1d": PeriodSpec("1d", "1d", 1440, label="日线"),
    # 日线聚合为周线：group_minutes = 7 天，实际收桶由 ISO 周边界决定
    "1w": PeriodSpec("1w", "1d", 1440, 7 * 1440, "周线"),
}


def is_supported(period: str) -> bool:
    return period in PERIODS


def trading_day_of(dt: datetime) -> datetime.date:
    """通达信标签已是交易日口径，夜盘与其白盘同属标签日期，直接取日期即可。"""
    return dt.date()


def aggregate(bars: Sequence[Bar], spec: PeriodSpec, session: str = "cn") -> list[Bar]:
    """按交易时段聚合源 K 线为更大周期。

    session="global" 用于伦敦金/银这类 24 小时连续品种：4 小时按墙钟整点切片，
    周线仍按 ISO 周；不做"交易日重置"，也不按交易分钟数累计。
    """
    if not spec.group_minutes:
        return list(bars)
    if not bars:
        return []
    if session == "global":
        return _aggregate_global(bars, spec)

    ordered = sorted(bars, key=lambda b: b.ts)
    grouped: list[Bar] = []
    bucket: list[Bar] = []
    active_minutes = 0
    bucket_index = 0
    prev_bucket = None
    weekly = spec.name == "1w"

    def flush() -> None:
        if not bucket:
            return
        grouped.append(
            Bar(
                time=bucket[0].time,
                ts=bucket[0].ts,
                open=bucket[0].open,
                high=max(b.high for b in bucket),
                low=min(b.low for b in bucket),
                close=bucket[-1].close,
                volume=sum(b.volume for b in bucket),
                oi=bucket[-1].oi,
            )
        )

    for bar in ordered:
        dt = datetime.strptime(bar.time, "%Y-%m-%d %H:%M")
        # 周线按 ISO 周收桶（一周内跨交易日不重置）；其余聚合周期按交易日收桶。
        key = dt.isocalendar()[:2] if weekly else trading_day_of(dt)
        if prev_bucket is not None and key != prev_bucket:
            flush()
            bucket, active_minutes, bucket_index = [], 0, 0

        # 每根源 K 线代表固定交易时长；午休/夜盘的墙钟断档不拆分交易分钟计数
        active_minutes += spec.interval_minutes
        idx = (active_minutes - 1) // spec.group_minutes
        if bucket and idx != bucket_index:
            flush()
            bucket = []
            active_minutes = spec.interval_minutes
            idx = 0
        bucket_index = idx
        bucket.append(bar)
        prev_bucket = key

    flush()
    return grouped


def _aggregate_global(bars: Sequence[Bar], spec: PeriodSpec) -> list[Bar]:
    """连续交易品种的聚合：4h 按墙钟整点分桶，周线按 ISO 周。"""
    ordered = sorted(bars, key=lambda b: b.ts)
    grouped: list[Bar] = []
    bucket: list[Bar] = []
    current: object = None
    weekly = spec.name == "1w"

    def flush() -> None:
        if not bucket:
            return
        grouped.append(
            Bar(
                time=bucket[0].time,
                ts=bucket[0].ts,
                open=bucket[0].open,
                high=max(b.high for b in bucket),
                low=min(b.low for b in bucket),
                close=bucket[-1].close,
                volume=sum(b.volume for b in bucket),
                oi=bucket[-1].oi,
            )
        )

    for bar in ordered:
        if weekly:
            dt = datetime.strptime(bar.time, "%Y-%m-%d %H:%M")
            key: object = dt.isocalendar()[:2]
        else:
            # 以 epoch 对齐整 4 小时，避免本地时区/夏令时把桶切歪
            key = int(bar.ts // (spec.group_minutes * 60_000))
        if current is not None and key != current:
            flush()
            bucket = []
        current = key
        bucket.append(bar)

    flush()
    return grouped


def descending_bars(bars: Iterable[Bar]) -> list[Bar]:
    """服务端统一返回旧→新，前端处理时再自行反向。"""
    return sorted(bars, key=lambda b: b.ts)
