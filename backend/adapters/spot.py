"""伦敦金/银现货适配器：瑞讯实时报价 + 东方财富历史快照 + 新浪回退。

数据源分工（2026-11 实测）：
- 实时价：Swissquote 公共 BBO（XAU/USD、XAG/USD），约 2 秒更新，无需 key；
- 日内历史：东方财富 trends2，5 天 1 分钟真实 OHLC，页面加载时拉一次并缓存 1 分钟，
  避免高频请求触发东财风控（实测高频请求会被断连/502）；
- 日线：东方财富 kline（klt=101，1992 年至今），缓存 10 分钟；
- 东财不可用时回退新浪 fx 分钟/日线，保证页面仍可用。

周期：1m/5m/15m/30m/1h 由 1m 快照聚合，4h 由服务层用 1h 聚合，1d 原生，1w 由日线聚合。
实时 bar 由瑞讯报价构造，30 秒的 K 线刷新对现货直接跳过，避免用旧快照覆盖实时 bar。
"""
from __future__ import annotations

import asyncio
import json
import logging
import ssl
import time
import urllib.request
import uuid
from datetime import datetime, timedelta

from ..domain.models import Bar, Quote, SymbolInfo, wall_ts
from .base import DataSource
from .sina_spot import SinaSpotAdapter

log = logging.getLogger("k-chart.spot")

# 参考新浪适配器：固定 TLS1.2，避免部分站点对 OpenSSL TLS1.3 的偶发断连。
TLS_CONTEXT = ssl.create_default_context()
TLS_CONTEXT.maximum_version = ssl.TLSVersion.TLSv1_2

SWISS_QUOTE_URL = "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/{inst}"
EM_TRENDS_URL = (
    "https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=122.{code}"
    "&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0"
)
EM_KLINE_URL = (
    "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=122.{code}"
    "&klt=101&fqt=0&lmt=10000&end=20500101"
    "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
)

INTRADAY_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}
INTRADAY_TTL = 60.0        # 东财分时快照缓存 1 分钟：页面加载时最多补拉一次，避免高频率
DAILY_TTL = 600.0          # 日线缓存 10 分钟（当天未收盘 bar 需要更新）
FALLBACK_TTL = 60.0        # 回退数据只缓存 1 分钟，便于尽快重试东财
EM_FAIL_BACKOFF = 600.0    # 东财失败后 10 分钟内不再请求
QUOTE_TTL = 1.0            # 报价缓存 1 秒
QUOTE_FAIL_BACKOFF = 30.0  # 瑞讯失败后 30 秒内用新浪报价

SESSION_START_HOUR = 7

SPOT_SYMBOLS = (
    SymbolInfo(
        code="XAU", market=9001, name="伦敦金", exchange="SPOT",
        source="spot", session="global", digits=2,
    ),
    SymbolInfo(
        code="XAG", market=9002, name="伦敦银", exchange="SPOT",
        source="spot", session="global", digits=2,
    ),
)


def _num(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


class SpotAdapter(DataSource):
    """伦敦金/银：瑞讯报价优先，东财历史优先，新浪兜底。"""

    static = True

    def __init__(self, timeout: float = 10.0) -> None:
        self.timeout = timeout
        self._sina = SinaSpotAdapter(timeout=timeout)
        self._nid = uuid.uuid4().hex
        self._quote_cache: dict[str, tuple[float, Quote]] = {}
        self._quote_fail_until = 0.0
        self._intraday: dict[str, tuple[float, list[Bar], float]] = {}
        self._daily: dict[str, tuple[float, list[Bar], float]] = {}
        self._prev_close: dict[str, float] = {}
        self._prev_close_attempt: dict[str, float] = {}
        self._em_fail_until = 0.0

    # ---------- 数据源接口 ----------

    async def symbols(self) -> list[SymbolInfo]:
        return [SymbolInfo(**s.to_dict()) for s in SPOT_SYMBOLS]

    async def bars(self, symbol: SymbolInfo, native_period: str, start: int, count: int) -> list[Bar]:
        rows = await asyncio.to_thread(self._bars_sync, symbol, native_period)
        start = max(0, int(start))
        count = max(1, int(count))
        end = len(rows) - start
        if end <= 0:
            return []
        return rows[max(0, end - count):end]

    async def quote(self, symbol: SymbolInfo) -> Quote:
        now = time.monotonic()
        cached = self._quote_cache.get(symbol.code)
        if cached and now - cached[0] < QUOTE_TTL:
            return cached[1]

        # 涨跌幅需要昨收：历史还没加载成功时，用新浪报价的 pre_close 兜底一次。
        if symbol.code not in self._prev_close and now >= self._prev_close_attempt.get(symbol.code, 0.0):
            self._prev_close_attempt[symbol.code] = now + 60
            try:
                fallback_quote = await asyncio.to_thread(self._sina.fallback_quote, symbol)
                if fallback_quote.pre_close > 0:
                    self._prev_close[symbol.code] = fallback_quote.pre_close
            except Exception:
                pass

        if now >= self._quote_fail_until:
            try:
                quote = await asyncio.to_thread(self._fetch_swiss_quote, symbol)
                self._quote_cache[symbol.code] = (time.monotonic(), quote)
                return quote
            except Exception as exc:
                self._quote_fail_until = now + QUOTE_FAIL_BACKOFF
                log.warning("瑞讯 %s 报价不可用，回退新浪: %s", symbol.code, exc)

        quote = await asyncio.to_thread(self._sina.fallback_quote, symbol)
        self._quote_cache[symbol.code] = (time.monotonic(), quote)
        return quote

    # ---------- HTTP ----------

    def _get(self, url: str, headers: dict[str, str], attempts: int = 2) -> str:
        last: Exception | None = None
        for index in range(attempts):
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout, context=TLS_CONTEXT) as response:
                    return response.read().decode("utf-8", "ignore")
            except Exception as exc:
                last = exc
                if index + 1 < attempts:
                    time.sleep(0.3 * (index + 1))
        raise last  # type: ignore[misc]

    def _em_headers(self) -> dict[str, str]:
        return {
            "Referer": "https://quote.eastmoney.com/",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120 Safari/537.36"
            ),
            "Accept": "*/*",
            "Connection": "close",
            "Cookie": f"nid={self._nid}",
        }

    # ---------- 实时 ----------

    def _fetch_swiss_quote(self, symbol: SymbolInfo) -> Quote:
        url = SWISS_QUOTE_URL.format(inst=f"{symbol.code}/USD")
        payload = json.loads(self._get(url, {"User-Agent": "Mozilla/5.0"}))
        entries = payload if isinstance(payload, list) else [payload]
        if not entries:
            raise LookupError("瑞讯无报价")

        entry = next(
            (e for e in entries if (e.get("topo") or {}).get("platform") == "SwissquoteLtd"),
            entries[0],
        )
        profiles = entry.get("spreadProfilePrices") or []
        if not profiles:
            raise LookupError("瑞讯报价字段为空")
        profile = next(
            (p for p in profiles if str(p.get("spreadProfile", "")).lower() == "premium"),
            profiles[0],
        )
        bid = _num(profile.get("bid"))
        ask = _num(profile.get("ask"))
        price = (bid + ask) / 2 if bid > 0 and ask > 0 else 0.0
        if price <= 0:
            raise LookupError("瑞讯报价无效")

        ts = int(_num(entry.get("ts")) or time.time() * 1000)
        pre_close = self._prev_close.get(symbol.code) or price
        return Quote(
            price=price, open=0.0, high=0.0, low=0.0, pre_close=pre_close,
            volume=0.0, oi=0.0, bid=bid, ask=ask, ts=ts,
        )

    # ---------- K 线 ----------

    def _bars_sync(self, symbol: SymbolInfo, native_period: str) -> list[Bar]:
        if native_period == "1d":
            return self._daily_bars(symbol)
        minutes = INTRADAY_MINUTES.get(native_period)
        if minutes is None:
            raise KeyError(f"伦敦金/银不支持的周期: {native_period}")
        base = self._intraday_bars(symbol)
        return base if minutes == 1 else self._aggregate_minutes(base, minutes)

    def _intraday_bars(self, symbol: SymbolInfo) -> list[Bar]:
        now = time.monotonic()
        cached = self._intraday.get(symbol.code)
        if cached and now - cached[0] < cached[2]:
            return cached[1]
        stale = cached[1] if cached else None

        if now >= self._em_fail_until:
            try:
                bars = self._fetch_em_trends(symbol)
                if not bars:
                    raise ValueError("东财分时为空")
                self._intraday[symbol.code] = (now, bars, INTRADAY_TTL)
                self._update_prev_close(symbol, bars)
                return bars
            except Exception as exc:
                self._em_fail_until = now + EM_FAIL_BACKOFF
                log.warning("东财 %s 分时不可用，回退/沿用缓存: %s", symbol.code, exc)

        if stale:
            self._update_prev_close(symbol, stale)
            self._intraday[symbol.code] = (now, stale, FALLBACK_TTL)
            return stale

        try:
            fallback = self._sina.fallback_bars(symbol, "1m")
        except Exception as exc:
            log.warning("新浪 %s 1m 回退失败: %s", symbol.code, exc)
            fallback = []
        self._update_prev_close(symbol, fallback)
        self._intraday[symbol.code] = (now, fallback, FALLBACK_TTL if fallback else 15.0)
        return fallback

    def _daily_bars(self, symbol: SymbolInfo) -> list[Bar]:
        now = time.monotonic()
        cached = self._daily.get(symbol.code)
        if cached and now - cached[0] < cached[2]:
            return cached[1]
        stale = cached[1] if cached else None

        if now >= self._em_fail_until:
            try:
                bars = self._fetch_em_daily(symbol)
                if not bars:
                    raise ValueError("东财日线为空")
                self._daily[symbol.code] = (now, bars, DAILY_TTL)
                self._update_prev_close_daily(symbol, bars)
                return bars
            except Exception as exc:
                self._em_fail_until = now + EM_FAIL_BACKOFF
                log.warning("东财 %s 日线不可用，回退/沿用缓存: %s", symbol.code, exc)

        if stale:
            self._update_prev_close_daily(symbol, stale)
            self._daily[symbol.code] = (now, stale, FALLBACK_TTL)
            return stale

        try:
            fallback = self._sina.fallback_bars(symbol, "1d")
        except Exception as exc:
            log.warning("新浪 %s 日线回退失败: %s", symbol.code, exc)
            fallback = []
        self._update_prev_close_daily(symbol, fallback)
        self._daily[symbol.code] = (now, fallback, FALLBACK_TTL if fallback else 15.0)
        return fallback

    def _fetch_em_trends(self, symbol: SymbolInfo) -> list[Bar]:
        raw = self._get(EM_TRENDS_URL.format(code=symbol.code), self._em_headers(), attempts=1)
        payload = json.loads(raw)
        data = payload.get("data") or {}
        rows = data.get("trends") or []
        by_ts: dict[int, Bar] = {}
        for row in rows:
            fields = str(row).split(",")
            if len(fields) < 6:
                continue
            time_str = fields[0]
            open_ = _num(fields[1])
            close = _num(fields[2])
            high = _num(fields[3])
            low = _num(fields[4])
            if min(open_, close, high, low) <= 0:
                continue
            high = max(high, open_, close)
            low = min(low, open_, close)
            ts = wall_ts(time_str)
            by_ts[ts] = Bar(
                time=time_str, ts=ts, open=open_, high=high, low=low, close=close,
                volume=_num(fields[5]), oi=0.0,
            )
        return [by_ts[ts] for ts in sorted(by_ts)]

    def _fetch_em_daily(self, symbol: SymbolInfo) -> list[Bar]:
        raw = self._get(EM_KLINE_URL.format(code=symbol.code), self._em_headers(), attempts=1)
        payload = json.loads(raw)
        data = payload.get("data") or {}
        rows = data.get("klines") or []
        by_ts: dict[int, Bar] = {}
        for row in rows:
            fields = str(row).split(",")
            if len(fields) < 5:
                continue
            date = fields[0]
            if len(date) != 10:
                continue
            open_ = _num(fields[1])
            close = _num(fields[2])
            high = _num(fields[3])
            low = _num(fields[4])
            if close <= 0:
                continue
            if open_ <= 0:
                open_ = close
            high = max(high, open_, close)
            low = min(low or close, open_, close)
            time_str = f"{date} {SESSION_START_HOUR:02d}:00"
            ts = wall_ts(time_str)
            by_ts[ts] = Bar(
                time=time_str, ts=ts, open=open_, high=high, low=low, close=close,
                volume=_num(fields[5]) if len(fields) > 5 else 0.0, oi=0.0,
            )
        return [by_ts[ts] for ts in sorted(by_ts)]

    # ---------- 口径辅助 ----------

    @staticmethod
    def _session_day() -> object:
        now = datetime.now()
        if now.hour < SESSION_START_HOUR:
            return (now - timedelta(days=1)).date()
        return now.date()

    def _update_prev_close(self, symbol: SymbolInfo, bars: list[Bar]) -> None:
        if not bars:
            return
        start = wall_ts(f"{self._session_day().isoformat()} {SESSION_START_HOUR:02d}:00")
        before = [b for b in bars if b.ts < start]
        if before:
            self._prev_close[symbol.code] = before[-1].close

    def _update_prev_close_daily(self, symbol: SymbolInfo, bars: list[Bar]) -> None:
        if len(bars) < 2:
            return
        last_day = bars[-1].time[:10]
        if last_day == self._session_day().isoformat():
            self._prev_close[symbol.code] = bars[-2].close
        else:
            self._prev_close[symbol.code] = bars[-1].close

    @staticmethod
    def _bucket_start(dt: datetime, minutes: int) -> datetime:
        if minutes >= 60:
            return dt.replace(minute=0, second=0)
        return dt.replace(minute=dt.minute // minutes * minutes, second=0)

    def _aggregate_minutes(self, bars: list[Bar], minutes: int) -> list[Bar]:
        buckets: dict[int, Bar] = {}
        for bar in bars:
            try:
                dt = datetime.strptime(bar.time, "%Y-%m-%d %H:%M")
            except ValueError:
                continue
            start = self._bucket_start(dt, minutes)
            time_str = start.strftime("%Y-%m-%d %H:%M")
            ts = wall_ts(time_str)
            current = buckets.get(ts)
            if current is None:
                buckets[ts] = Bar(
                    time=time_str, ts=ts, open=bar.open, high=bar.high,
                    low=bar.low, close=bar.close, volume=bar.volume, oi=bar.oi,
                )
            else:
                current.high = max(current.high, bar.high)
                current.low = min(current.low, bar.low)
                current.close = bar.close
                current.volume += bar.volume
                current.oi = bar.oi
        return [buckets[ts] for ts in sorted(buckets)]
