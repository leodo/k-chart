"""新浪外盘现货适配器：伦敦金（XAU/USD）、伦敦银（XAG/USD）。

为什么单独一个数据源：
- 通达信 7727 扩展行情没有伦敦现货，只有 COMEX 黄金/白银期货、上海黄金交易所
  品种和"伦敦金定盘价"这种日频宏观指标，拿不到 24 小时现货行情；
- 新浪财经的外盘/外汇接口同时提供实时报价、1~60 分钟 K 线和 2006 年至今的日线，
  且不需要 key，适合作为伦敦金/银的数据源。

接口口径（已实测）：
- 实时：hq.sinajs.cn/list=fx_sxauusd（GBK，必须带 Referer），字段
  [1]=买价 [2]=最新价 [3]=昨收 [4]=成交量 [5]=今开 [6]=最高 [7]=最低 [8]=卖价 [17]=日期；
- 分钟：NewForexService.getMinKline?scale=1/5/15/30/60，5 分钟及以上最多约 1000 根，
  1 分钟固定 1440 根（24 小时）；
- 日线：GlobalFuturesService.getGlobalFuturesDailyKLine，约 5180 根（2006 至今），
  当天未收盘的 K 线也在里面。

两个必须处理的坑：
1. 5 分钟及以上周期的价格是"尾数"（黄金 0.3624、白银 0.4243），要按当前价的
   整数位数还原（黄金 ×10000、白银 ×100）；1 分钟返回真实价格。
2. 5 分钟及以上周期的标签是区间【结束】时间（16:10 的 5 分钟 K 线覆盖 16:05~16:10），
   入库前减掉周期长度，统一成【开始】时间，才能和实时 bar、其它周期对齐。
"""
from __future__ import annotations

import asyncio
import json
import re
import ssl
import time
import urllib.request
from datetime import datetime, timedelta

from ..domain.models import Bar, Quote, SymbolInfo, wall_ts
from .base import DataSource

HEADERS = {
    "Referer": "https://finance.sina.com.cn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) k-chart/1.0",
}

# 新浪/雅虎等站点对 OpenSSL 的 TLS1.3 ClientHello 会偶发 UNEXPECTED_EOF，
# 固定用 TLS1.2 可稳定取数（实测 hq.sinajs.cn、NewForexService 均正常）。
TLS_CONTEXT = ssl.create_default_context()
TLS_CONTEXT.maximum_version = ssl.TLSVersion.TLSv1_2

MIN_URL = (
    "https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_{fx}=/"
    "NewForexService.getMinKline?symbol={fx}&scale={scale}&datalen=2000"
)
DAY_URL = (
    "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{code}=/"
    "GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={code}"
)
QUOTE_URL = "https://hq.sinajs.cn/list={fx}"

MIN_SCALE = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}

# 连续交易品种的日线按北京时间 07:00 切日（新浪日线也是这个口径）
SESSION_START_HOUR = 7

SPOT_SYMBOLS = (
    SymbolInfo(
        code="XAU", market=9001, name="伦敦金", exchange="SPOT",
        source="sina", session="global", digits=2,
    ),
    SymbolInfo(
        code="XAG", market=9002, name="伦敦银", exchange="SPOT",
        source="sina", session="global", digits=2,
    ),
)

# 新浪分钟接口的尾数倍率兜底：行情接口不可用时仍能出图
DEFAULT_FACTOR = {"XAU": 10000.0, "XAG": 100.0}


def _json_array(text: str) -> list:
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("新浪返回内容不是 JSON 数组")
    return json.loads(text[start:end + 1])


def _num(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


class SinaSpotAdapter(DataSource):
    """伦敦金/银现货数据源（新浪财经）。"""

    static = True  # 合约列表固定，不需要像通达信那样全市场扫描

    def __init__(self, timeout: float = 8.0) -> None:
        self.timeout = timeout
        self._bars_cache: dict[tuple[str, str], tuple[float, list[Bar]]] = {}
        self._quote_cache: dict[str, tuple[float, Quote]] = {}
        self._spot: dict[str, tuple[float, float]] = {}

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
        if cached and now - cached[0] < 1.0:
            return cached[1]
        quote = await asyncio.to_thread(self._fetch_quote, symbol)
        self._quote_cache[symbol.code] = (time.monotonic(), quote)
        return quote

    # ---------- 供 SpotAdapter 回退（东方财富/瑞讯不可用时） ----------

    def fallback_bars(self, symbol: SymbolInfo, native_period: str) -> list[Bar]:
        if native_period == "1d":
            return self._fetch_daily(symbol)
        return self._fetch_minute(symbol, native_period)

    def fallback_quote(self, symbol: SymbolInfo) -> Quote:
        return self._fetch_quote(symbol)

    # ---------- HTTP ----------

    def _get(self, url: str, attempts: int = 3) -> str:
        last: Exception | None = None
        for index in range(attempts):
            request = urllib.request.Request(url, headers=HEADERS)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout, context=TLS_CONTEXT) as response:
                    return response.read().decode("gbk", "ignore")
            except Exception as exc:  # 握手偶发 EOF，重试一次通常即可
                last = exc
                if index + 1 < attempts:
                    time.sleep(0.3 * (index + 1))
        raise last  # type: ignore[misc]

    @staticmethod
    def _fx_code(symbol: SymbolInfo) -> str:
        return f"fx_s{symbol.code.lower()}usd"

    # ---------- 实时 ----------

    def _fetch_quote(self, symbol: SymbolInfo) -> Quote:
        text = self._get(QUOTE_URL.format(fx=self._fx_code(symbol)))
        matched = re.search(r'"(.*)"', text)
        if not matched:
            raise LookupError(f"新浪无报价: {symbol.code}")
        fields = matched.group(1).split(",")
        if len(fields) < 18:
            raise LookupError(f"新浪报价字段不完整: {symbol.code}")

        price = _num(fields[2])
        if price <= 0:
            raise LookupError(f"新浪报价为空: {symbol.code}")
        prev_close = _num(fields[3])
        stamp = f"{fields[17].strip()} {fields[0].strip()[:5]}"
        try:
            ts = wall_ts(stamp)
        except Exception:
            ts = int(datetime.now().timestamp() * 1000)
        if ts <= 0:
            ts = int(datetime.now().timestamp() * 1000)

        quote = Quote(
            price=price,
            open=_num(fields[5]),
            high=_num(fields[6]),
            low=_num(fields[7]),
            pre_close=prev_close,
            volume=0.0,  # 现货成交量口径与期货不同，且历史 K 线没有量，统一按 0 处理
            oi=0.0,
            bid=_num(fields[1]),
            ask=_num(fields[8]),
            ts=ts,
        )
        self._spot[symbol.code] = (price, time.monotonic())
        return quote

    # ---------- K 线 ----------

    def _bars_sync(self, symbol: SymbolInfo, native_period: str) -> list[Bar]:
        ttl = 20.0 if native_period == "1d" else 4.0
        cached = self._bars_cache.get((symbol.code, native_period))
        if cached and time.monotonic() - cached[0] < ttl:
            return cached[1]

        if native_period == "1d":
            bars = self._fetch_daily(symbol)
        elif native_period in MIN_SCALE:
            bars = self._fetch_minute(symbol, native_period)
        else:
            raise KeyError(f"伦敦金/银不支持的周期: {native_period}")

        self._bars_cache[(symbol.code, native_period)] = (time.monotonic(), bars)
        return bars

    def _spot_price(self, symbol: SymbolInfo) -> float:
        cached = self._spot.get(symbol.code)
        if cached and time.monotonic() - cached[1] < 30:
            return cached[0]
        try:
            return self._fetch_quote(symbol).price
        except Exception:
            return 0.0

    def _scale_factor(self, raw_close: float, spot: float, code: str) -> float:
        """分钟接口 5m+ 的价格是尾数，按当前价的整数位数还原。"""
        fallback = DEFAULT_FACTOR.get(code, 1.0)
        if spot <= 0 or raw_close <= 0:
            return fallback
        candidates = (1.0, 10.0, 100.0, 1000.0, 10000.0, 100000.0, 1000000.0)
        best = min(candidates, key=lambda factor: abs(raw_close * factor - spot))
        if abs(raw_close * best - spot) / spot > 0.25:
            return fallback
        return best

    def _fetch_minute(self, symbol: SymbolInfo, native_period: str) -> list[Bar]:
        scale = MIN_SCALE[native_period]
        text = self._get(MIN_URL.format(fx=self._fx_code(symbol), scale=scale))
        rows = _json_array(text)
        if not rows:
            return []

        raw_close = _num(rows[-1].get("c"))
        factor = self._scale_factor(raw_close, self._spot_price(symbol), symbol.code)
        shift = timedelta(minutes=scale) if scale > 1 else timedelta(0)

        by_ts: dict[int, Bar] = {}
        for row in rows:
            try:
                dt = datetime.strptime(str(row.get("d")), "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            dt -= shift
            time_str = dt.strftime("%Y-%m-%d %H:%M")
            ts = wall_ts(time_str)
            open_ = _num(row.get("o")) * factor
            high = _num(row.get("h")) * factor
            low = _num(row.get("l")) * factor
            close = _num(row.get("c")) * factor
            # 新浪偶有开/收落在高低之外的脏行，先夹紧再入库
            high = max(high, open_, close)
            low = min(low, open_, close)
            by_ts[ts] = Bar(
                time=time_str,
                ts=ts,
                open=open_,
                high=high,
                low=low,
                close=close,
                volume=0.0,
                oi=0.0,
            )
        bars = [by_ts[ts] for ts in sorted(by_ts)]
        if scale > 1:
            bars = self._fill_recent_gaps(symbol, bars, scale)
        return bars

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

    def _fill_recent_gaps(self, symbol: SymbolInfo, bars: list[Bar], minutes: int) -> list[Bar]:
        """用 1 分钟序列补齐 5m/15m/30m/60m 的缺口。

        实测新浪 scale=5/15 的聚合序列在部分时段会比 1 分钟序列滞后近 1 小时
        （1m 已到 18:28，5m 还停在 17:35），表现为最近几根 5m/15m K 线缺失。
        1 分钟序列是最新的，把它聚合到目标周期后只补缺失的时间桶，已有桶保持
        新浪原生 OHLC 不变。
        """
        if not bars:
            return bars
        try:
            base = self._fetch_minute(symbol, "1m")
        except Exception:
            return bars
        if not base:
            return bars
        aggregated = self._aggregate_minutes(base, minutes)
        by_ts = {b.ts: b for b in bars}
        oldest = bars[0].ts
        added = 0
        for b in aggregated:
            if b.ts > oldest and b.ts not in by_ts:
                by_ts[b.ts] = b
                added += 1
        if not added:
            return bars
        return [by_ts[ts] for ts in sorted(by_ts)]

    def _fetch_daily(self, symbol: SymbolInfo) -> list[Bar]:
        text = self._get(DAY_URL.format(code=symbol.code))
        rows = _json_array(text)
        by_ts: dict[int, Bar] = {}
        for row in rows:
            date = str(row.get("date") or "").strip()
            if len(date) != 10:
                continue
            close = _num(row.get("close"))
            if close <= 0:
                continue
            open_ = _num(row.get("open"))
            high = _num(row.get("high"))
            low = _num(row.get("low"))
            if open_ <= 0:
                open_ = close
            high = max(high, open_, close)
            low = min(low or close, open_, close)
            time_str = f"{date} {SESSION_START_HOUR:02d}:00"
            ts = wall_ts(time_str)
            by_ts[ts] = Bar(
                time=time_str,
                ts=ts,
                open=open_,
                high=high,
                low=low,
                close=close,
                volume=_num(row.get("volume")),
                oi=_num(row.get("position")),
            )
        return [by_ts[ts] for ts in sorted(by_ts)]
