"""领域模型：与具体数据源、传输协议无关。"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any


def trading_ts(time_str: str) -> int:
    """把通达信的"交易日口径"时间标签转成交易时序时间戳。

    通达信/pytdx 返回的时间标签已是交易日口径：夜盘标为其所属交易日日期，
    但时钟仍是真实的 21:05。因此同一交易日里，夜盘(21:00) 的墙钟时间大于
    白盘(09:00~15:00)，若按真实时间排序会把夜盘排到白盘后面，与交易实际顺序相反。

    正确交易时序：一个交易日 = 前一夜盘在前 + 当日白盘在后。
    把 >=18:00 的夜盘时刻减一天，即可让它排在同日白盘之前，得到正确的K线顺序。
    """
    try:
        dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M")
    except ValueError:
        dt = datetime.fromtimestamp(0)
    if dt.hour >= 18:  # 夜盘：往前挪一天，排在当日白盘之前
        dt = dt - timedelta(days=1)
    return int(dt.timestamp() * 1000)


@dataclass(slots=True)
class Bar:
    time: str          # 'YYYY-MM-DD HH:MM'
    ts: int            # 毫秒时间戳，仅用于前端定位与排序
    open: float
    high: float
    low: float
    close: float
    volume: float
    oi: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_tdx(cls, raw: dict[str, Any]) -> "Bar":
        time_str = str(raw.get("datetime") or "")
        try:
            dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M")
        except ValueError:
            dt = datetime.fromtimestamp(0)
        return cls(
            time=time_str,
            ts=trading_ts(time_str),
            open=float(raw.get("open") or 0),
            high=float(raw.get("high") or 0),
            low=float(raw.get("low") or 0),
            close=float(raw.get("close") or 0),
            volume=float(raw.get("trade") or 0),
            oi=float(raw.get("position") or 0),
        )


@dataclass(slots=True)
class Quote:
    price: float
    open: float
    high: float
    low: float
    pre_close: float
    volume: float
    oi: float
    bid: float
    ask: float
    ts: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class SymbolInfo:
    code: str          # RBL9
    market: int        # 30
    name: str          # 螺纹加权
    exchange: str      # SHFE / DCE / CZCE / GFEX / CFFEX

    @property
    def key(self) -> str:
        return f"{self.market}:{self.code}"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
