"""实时轮询与广播。

pytdx 没有推送协议，所以用短轮询快照 + WebSocket 广播模拟实时；
前端按 time 做 upsert，天然容忍重复与乱序。
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta

from fastapi import WebSocket

from .. import config
from ..domain.models import Bar, Quote, trading_ts, wall_ts
from ..domain.periods import trading_day_of
from .market_data import MarketDataService

TIME_FMT = "%Y-%m-%d %H:%M"
# 伦敦金/银按北京时间 07:00 切日，与新浪日线口径一致
GLOBAL_SESSION_START = 7


def _global_label(quote_ts: int, period: str) -> str:
    now = datetime.fromtimestamp(quote_ts / 1000)
    if period == "1d":
        day = now.date()
        if now.hour < GLOBAL_SESSION_START:
            day = day - timedelta(days=1)
        return f"{day.isoformat()} {GLOBAL_SESSION_START:02d}:00"
    if period == "1w":
        monday = now.date() - timedelta(days=now.weekday())
        return f"{monday.isoformat()} {GLOBAL_SESSION_START:02d}:00"
    if period == "1h":
        return now.strftime("%Y-%m-%d %H:00")
    if period == "4h":
        hour = now.hour // 4 * 4
        return f"{now.date().isoformat()} {hour:02d}:00"
    step = max(1, int(period[:-1])) if period.endswith("m") else 1
    minute = now.minute // step * step
    return now.strftime(f"%Y-%m-%d %H:{minute:02d}")


def _bucket_label(quote_ts: int, period: str, last: Bar | None, session: str = "cn") -> str:
    # 24 小时连续品种：标签按真实墙钟算（5m/15m/30m/1h 取区间开始时间）。
    if session == "global":
        return _global_label(quote_ts, period)
    # 通达信把夜盘归到下一交易日，而本机系统时间未必同步；
    # 有历史末根时一律沿用它的数据时间标签，只对最后一根做行情更新。
    if last:
        return last.time
    now = datetime.fromtimestamp(quote_ts / 1000)
    if period == "1d":
        return f"{trading_day_of(now)} 15:00"
    if period == "1w":
        # 与周线聚合保持一致：周一根日线的时间标签作为整周标签
        monday = now.date() - timedelta(days=now.weekday())
        return f"{monday.isoformat()} 15:00"
    if period == "1h":
        return now.strftime("%Y-%m-%d %H:00")
    step = max(1, int(period[:-1])) if period.endswith("m") else 1
    minute = now.minute // step * step
    return now.strftime(f"%Y-%m-%d %H:{minute:02d}")


def build_live_bar(quote: Quote, period: str, last: Bar | None, volume_delta: float,
                   session: str = "cn") -> Bar:
    """用 tick 增量构造当前周期的实时 K 线。

    quote 的 zongliang / high / low 都是"当日累计"口径，不能当成本周期数据：
    - 成交量必须用相邻两次快照的累计量之差，叠加到上一根实时 bar 上；
    - 最高/最低只能用现价去扩展上一根 bar，不能用当日最高/最低。
    """
    label = _bucket_label(quote.ts, period, last, session)
    ts = wall_ts(label) if session == "global" else trading_ts(label)
    if last and last.ts == ts:
        open_ = last.open
        high = max(last.high, quote.price)
        low = min(last.low, quote.price)
        volume = max(0.0, last.volume + volume_delta)
    elif period == "1d" and session == "cn" and quote.open > 0 and quote.high >= quote.low > 0:
        # 新交易日第一笔：用当日累计开高低初始化，避免日线开局只有一根影线
        open_ = quote.open
        high = max(quote.high, quote.price)
        low = min(quote.low, quote.price)
        volume = max(0.0, volume_delta)
    else:
        # 新周期：quote 的 OHLC 是当日口径，统一用现价初始化本周期 bar
        open_ = quote.price
        high = quote.price
        low = quote.price
        volume = max(0.0, volume_delta)
    return Bar(
        time=label,
        ts=ts,
        open=open_,
        high=high,
        low=low,
        close=quote.price,
        volume=volume,
        oi=quote.oi,
    )


def _same_bar(a: Bar | None, b: Bar) -> bool:
    """同一根 K 线且价格/量都没变 —— 收盘或长时间无成交时不必推送。"""
    if a is None:
        return False
    return (
        a.time == b.time and a.open == b.open and a.high == b.high
        and a.low == b.low and a.close == b.close
        and a.volume == b.volume and a.oi == b.oi
    )


class RealtimeHub:
    def __init__(self, service: MarketDataService) -> None:
        self.service = service
        self._subs: dict[WebSocket, tuple[str, str]] = {}
        self._last: dict[tuple[str, str], Bar] = {}
        self._refreshed: dict[tuple[str, str], float] = {}
        # 上一 tick 的当日累计成交量，用来算本周期成交量增量
        self._prev_vol: dict[tuple[str, str], float] = {}
        self._task: asyncio.Task | None = None

    async def subscribe(self, ws: WebSocket, symbol_code: str, period: str) -> None:
        symbol = self.service.resolve(symbol_code)
        key = (symbol.key, period)
        last = await self.service.latest_bar(symbol, period)
        if last:
            self._last[key] = last
        self._prev_vol.pop(key, None)  # 新订阅从下一 tick 重新建立累计量基准
        self._subs[ws] = key

    def unsubscribe(self, ws: WebSocket) -> None:
        self._subs.pop(ws, None)

    async def _send(self, ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_json(message)
        except Exception:
            self.unsubscribe(ws)

    async def loop(self) -> None:
        while True:
            pairs = list(set(self._subs.values()))
            if not pairs:
                await asyncio.sleep(0.5)
                continue
            for key in pairs:
                symbol_key, period = key
                try:
                    market, code = symbol_key.split(":", 1)
                    symbol = next(s for s in self.service.symbols if s.key == symbol_key)
                    quote = await self.service.source_for(symbol).quote(symbol)
                    prev_vol = self._prev_vol.get(key)
                    if prev_vol is None:
                        delta = 0.0
                    elif quote.volume >= prev_vol:
                        delta = quote.volume - prev_vol
                    else:
                        delta = quote.volume  # 新交易日累计量归零
                    self._prev_vol[key] = quote.volume
                    bar = build_live_bar(quote, period, self._last.get(key), delta, symbol.session)
                    prev = self._last.get(key)
                    self._last[key] = bar
                    if not _same_bar(prev, bar):
                        message = {
                            "type": "tick",
                            "symbol": code,
                            "period": period,
                            "bar": bar.to_dict(),
                            "quote": quote.to_dict(),
                        }
                        await asyncio.gather(
                            *(self._send(ws, message) for ws, v in list(self._subs.items()) if v == key)
                        )

                    now_mono = time.monotonic()
                    if now_mono - self._refreshed.get(key, 0) >= config.BAR_REFRESH_SECONDS:
                        self._refreshed[key] = now_mono
                        refreshed = await self.service.refresh_latest(symbol, period)
                        if refreshed:
                            self._last[key] = refreshed[-1]
                            self._prev_vol[key] = quote.volume  # 与真实 K 线对齐后重置累计基准
                            bars_msg = {
                                "type": "bars",
                                "symbol": code,
                                "period": period,
                                "bars": [b.to_dict() for b in refreshed],
                            }
                            await asyncio.gather(
                                *(self._send(ws, bars_msg) for ws, v in list(self._subs.items()) if v == key)
                            )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    continue
            await asyncio.sleep(config.REALTIME_POLL_SECONDS)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.loop(), name="realtime-loop")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
