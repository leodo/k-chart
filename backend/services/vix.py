"""商品期权隐含波动率指数（近似 VIX）计算与缓存。

数据源：通达信 7727 扩展行情。方法：近月/次近月平值期权用 Black-76 反推 IV，
按日历天把两个期限的方差插值到 30 天，100*sqrt(方差) 得到指数点。
注意：这是近似指标，不是交易所官方发布的 VIX。
"""
from __future__ import annotations

import asyncio
import calendar
import math
import re
import sqlite3
import statistics
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from pytdx.exhq import TdxExHq_API
from pytdx.params import TDXParams

from .. import config
from ..adapters.tdx_ext import read_hosts
from ..domain.models import trading_ts

OPTION_MARKETS = {4: "CZCE", 5: "DCE", 6: "SHFE", 7: "CFFEX", 67: "GFEX"}
FUTURES_MARKET = {"CZCE": 28, "DCE": 29, "SHFE": 30, "CFFEX": 47, "GFEX": 66}
# 中金所股指期权代码和期货代码不同：IM→MO、IF→IO、IH→HO
OPTION_PRODUCT = {"IM": "MO", "IF": "IO", "IH": "HO"}
NAME_RE = re.compile(r"^([A-Za-z]+)(\d{4})-([CP])-(\d+(?:\.\d+)?)$")
RISK_FREE = 0.02
INTRADAY_CATEGORIES = {
    "5m": TDXParams.KLINE_TYPE_5MIN,
    "15m": TDXParams.KLINE_TYPE_15MIN,
    "30m": TDXParams.KLINE_TYPE_30MIN,
    "1h": TDXParams.KLINE_TYPE_1HOUR,
}


_HOST_CACHE = Path(config.DB_PATH).parent / "vix_host.txt"


def _preferred_hosts() -> list[str]:
    hosts = read_hosts(config.TDX_CONNECT_CFG)
    try:
        cached = _HOST_CACHE.read_text(encoding="utf-8").strip()
        if cached in hosts:
            return [cached] + [h for h in hosts if h != cached]
    except OSError:
        pass
    return hosts


def connect() -> tuple[TdxExHq_API, str]:
    api = TdxExHq_API()
    for host in _preferred_hosts():
        try:
            api.connect(host, config.TDX_PORT, time_out=config.HOST_PROBE_TIMEOUT)
            if api.get_markets():
                try:
                    _HOST_CACHE.write_text(host, encoding="utf-8")
                except OSError:
                    pass
                return api, host
        except Exception:
            continue
    raise ConnectionError("没有可用的通达信 7727 服务器")


def product_of(code: str) -> str:
    code = code.upper()
    return code[:-2] if code.endswith("L9") else code


def option_product_of(code: str) -> str:
    product = product_of(code)
    return OPTION_PRODUCT.get(product, product)


def scan_options(api: TdxExHq_API) -> list[dict[str, Any]]:
    total = int(api.get_instrument_count() or 0)
    out: list[dict[str, Any]] = []
    for start in range(0, total, 1000):
        for row in api.get_instrument_info(start, 1000) or []:
            market = int(row.get("market") or 0)
            if market not in OPTION_MARKETS:
                continue
            matched = NAME_RE.match(str(row.get("name") or ""))
            if not matched:
                continue
            product, yymm, cp, strike = matched.groups()
            out.append({
                "code": str(row.get("code") or ""),
                "name": str(row.get("name") or ""),
                "market": market,
                "exchange": OPTION_MARKETS[market],
                "product": product.upper(),
                "expiry": f"20{yymm[:2]}{yymm[2:]}",
                "cp": "call" if cp == "C" else "put",
                "strike": float(strike),
            })
    return out


def option_products(options: Iterable[dict[str, Any]]) -> set[tuple[str, str]]:
    return {(item["exchange"], item["product"]) for item in options}


def expiry_date(expiry: str, exchange: str = "") -> date:
    """到期日近似：中金所股指期权为当月第三个周五，商品期权用合约月 5 号近似。"""
    year, month = int(expiry[:4]), int(expiry[4:])
    if exchange == "CFFEX":
        first = date(year, month, 1)
        return first + timedelta(days=(4 - first.weekday()) % 7 + 14)
    return date(year, month, 5)


def _n(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _smooth(values: list[float], half: int = 2, alpha: float = 0.4) -> list[float]:
    """5 日中位数去孤立毛刺 + 轻度 EWMA，避免脏报价把叠加线画成锯齿。"""
    if not values:
        return []
    med = [
        statistics.median(values[max(0, i - half):min(len(values), i + half + 1)])
        for i in range(len(values))
    ]
    out = [med[0]]
    for value in med[1:]:
        out.append(out[-1] * (1 - alpha) + value * alpha)
    return out


def black76_price(f: float, k: float, t: float, r: float, sigma: float, is_call: bool) -> float:
    if t <= 0 or sigma <= 0 or f <= 0 or k <= 0:
        return max(0.0, (f - k) if is_call else (k - f))
    vol = sigma * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * sigma * sigma * t) / vol
    d2 = d1 - vol
    disc = math.exp(-r * t)
    if is_call:
        return disc * (f * _n(d1) - k * _n(d2))
    return disc * (k * _n(-d2) - f * _n(-d1))


def implied_vol(price: float, f: float, k: float, t: float, is_call: bool) -> float:
    intrinsic = max(0.0, (f - k) if is_call else (k - f))
    if t <= 0 or price <= intrinsic + 1e-6 or f <= 0 or k <= 0:
        return float("nan")
    lo, hi = 1e-4, 5.0
    if black76_price(f, k, t, 0.0, hi, is_call) < price:
        return float("nan")
    for _ in range(60):
        mid = (lo + hi) / 2
        if black76_price(f, k, t, RISK_FREE, mid, is_call) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def daily_close(api: TdxExHq_API, market: int, code: str, count: int) -> dict[str, float]:
    rows = api.get_instrument_bars(TDXParams.KLINE_TYPE_DAILY, market, code, 0, count) or []
    out: dict[str, float] = {}
    for row in rows:
        day = str(row.get("datetime") or "")[:10]
        close = float(row.get("close") or 0)
        if len(day) == 10 and close > 0:
            out[day] = close
    return out


def intraday_closes(api: TdxExHq_API, market: int, code: str, category: int,
                    blocks: int = 2, per: int = 700) -> dict[str, float]:
    """按时间标签取日内收盘价；通达信单次最多 700 根，这里按需向前翻页。"""
    out: dict[str, float] = {}
    for start in range(0, blocks * per, per):
        rows = api.get_instrument_bars(category, market, code, start, per) or []
        for row in rows:
            stamp = str(row.get("datetime") or "")
            close = float(row.get("close") or 0)
            if len(stamp) >= 16 and close > 0:
                out[stamp] = close
        if len(rows) < per:
            break
    return out


def _time_to_expiry(expiry: str, stamp: str, exchange: str = "") -> float:
    end = datetime.combine(expiry_date(expiry, exchange), datetime.min.time()).replace(hour=15)
    current = datetime.strptime(stamp, "%Y-%m-%d %H:%M")
    return (end - current).total_seconds() / 86400 / 365


def _pick_strikes(chain: list[dict[str, Any]], expiry: str, ref: float, count: int = 5) -> list[float]:
    both = {
        item["strike"] for item in chain
        if item["expiry"] == expiry and item["cp"] == "call"
    } & {
        item["strike"] for item in chain
        if item["expiry"] == expiry and item["cp"] == "put"
    }
    if not both:
        return []
    return sorted(sorted(both, key=lambda k: abs(k - ref))[:count])


def _smooth_intraday(values: list[float]) -> list[float]:
    """日内只需去掉单点脏价，不能把真实的方向变化抹平。"""
    if not values:
        return []
    med = [
        statistics.median(values[max(0, i - 1):min(len(values), i + 2)])
        for i in range(len(values))
    ]
    out = [med[0]]
    for value in med[1:]:
        out.append(out[-1] * 0.5 + value * 0.5)
    return out


def _atm_strike(chain: list[dict[str, Any]], expiry: str, forward: float) -> float | None:
    strikes = sorted({
        item["strike"] for item in chain
        if item["expiry"] == expiry and item["cp"] == "call"
    } & {
        item["strike"] for item in chain
        if item["expiry"] == expiry and item["cp"] == "put"
    })
    if not strikes or forward <= 0:
        return None
    return min(strikes, key=lambda k: abs(k - forward))


def _option_code(chain: list[dict[str, Any]], expiry: str, cp: str, strike: float) -> tuple[int, str] | None:
    for item in chain:
        if item["expiry"] == expiry and item["cp"] == cp and abs(item["strike"] - strike) < 1e-6:
            return item["market"], item["code"]
    return None


def compute_symbol(api: TdxExHq_API, symbol: dict[str, Any], options: list[dict[str, Any]], days: int = 260) -> list[dict[str, Any]]:
    product = product_of(symbol["code"])
    opt_product = option_product_of(symbol["code"])
    chain = [
        item for item in options
        if item["exchange"] == symbol["exchange"] and item["product"] == opt_product
    ]
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for item in chain:
        if item["name"] in seen:
            continue
        seen.add(item["name"])
        unique.append(item)
    chain = unique

    today = date.today()
    expiries = sorted({item["expiry"] for item in chain
                       if expiry_date(item["expiry"], symbol["exchange"]) > today})[:2]
    if not expiries:
        return []

    fut_market = FUTURES_MARKET[symbol["exchange"]]
    futures: dict[str, dict[str, float]] = {}
    latest_forward: dict[str, float] = {}
    for expiry in expiries:
        code = f"{product}{expiry[2:]}"
        futures[expiry] = daily_close(api, fut_market, code, days)
        closes = sorted(futures[expiry].items())
        latest_forward[expiry] = closes[-1][1] if closes else 0.0

    # 每个到期只取最近的一小组行权价。历史日期上平值会漂移，
    # 固定用最新平值会让老数据变成深度实值/虚值，IV 因而忽高忽低。
    strikes: dict[str, list[float]] = {}
    for expiry in expiries:
        both = {
            item["strike"] for item in chain
            if item["expiry"] == expiry and item["cp"] == "call"
        } & {
            item["strike"] for item in chain
            if item["expiry"] == expiry and item["cp"] == "put"
        }
        ref = latest_forward[expiry] or 0.0
        strikes[expiry] = sorted(sorted(both, key=lambda k: abs(k - ref))[:5])

    option_closes: dict[tuple[str, str, float], dict[str, float]] = {}
    for expiry in expiries:
        for strike in strikes[expiry]:
            for cp in ("call", "put"):
                found = _option_code(chain, expiry, cp, strike)
                if found:
                    market, code = found
                    option_closes[(expiry, cp, strike)] = daily_close(api, market, code, days)

    dates = sorted(set().union(*(set(futures[e]) for e in expiries)))
    rows: list[dict[str, Any]] = []
    for day in dates:
        available: list[tuple[float, float, float]] = []  # (期限, 方差, IV)
        iv_by_expiry: dict[str, float] = {}
        for expiry in expiries:
            f = futures[expiry].get(day, 0.0)
            if not f or not strikes[expiry]:
                continue
            strike = min(strikes[expiry], key=lambda k: abs(k - f))
            call_px = option_closes.get((expiry, "call", strike), {}).get(day, 0.0)
            put_px = option_closes.get((expiry, "put", strike), {}).get(day, 0.0)
            t = (expiry_date(expiry, symbol["exchange"]) - date.fromisoformat(day)).days / 365
            if t <= 0 or not (call_px > 0 or put_px > 0):
                continue
            # 取虚值一侧：深度实值期权结算价滞后，反推的 IV 噪声很大。
            if strike >= f and call_px > 0:
                iv = implied_vol(call_px, f, strike, t, True)
            elif strike < f and put_px > 0:
                iv = implied_vol(put_px, f, strike, t, False)
            else:
                iv = implied_vol(call_px or put_px, f, strike, t, strike >= f)
            if not math.isfinite(iv):
                continue
            available.append((t, iv * iv, iv))
            iv_by_expiry[expiry] = iv

        if not available:
            continue
        if len(available) == 1:
            var30 = available[0][1]
        else:
            (t1, v1, _), (t2, v2, _) = available[0], available[1]
            if t1 < 7 / 365 or t2 <= 30 / 365:
                var30 = v2
            elif t1 <= 30 / 365 < t2:
                weight = (t2 - 30 / 365) / (t2 - t1)
                var30 = weight * v1 + (1 - weight) * v2
            else:
                var30 = v1

        rows.append({
            "symbol": symbol["code"],
            "date": day,
            "ts": trading_ts(f"{day} 15:00"),
            "vix": round(100 * math.sqrt(max(0.0, var30)), 2),
            "iv_near": round(iv_by_expiry[expiries[0]] * 100, 2) if expiries[0] in iv_by_expiry else None,
            "iv_next": round(iv_by_expiry[expiries[1]] * 100, 2) if len(expiries) > 1 and expiries[1] in iv_by_expiry else None,
            "expiry_near": expiries[0],
            "expiry_next": expiries[1] if len(expiries) > 1 else None,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        })

    # 结算价偶发脏数据会留下单日跳变，入库前统一做一次稳健平滑。
    for key in ("vix", "iv_near", "iv_next"):
        values = [r[key] for r in rows if r[key] is not None]
        smoothed = iter(_smooth(values))
        for row in rows:
            if row[key] is not None:
                row[key] = round(next(smoothed), 2)
    return rows


def compute_symbol_intraday(api: TdxExHq_API, symbol: dict[str, Any],
                            options: list[dict[str, Any]], period: str,
                            blocks: int = 2) -> list[dict[str, Any]]:
    """用期权与期货的同期日内 K 线反推每个 bar 的 30 天隐波。

    与日线序列不同，这里能反映盘中涨跌对应的隐波变化：下跌时 IV 抬升、反弹时回落。
    """
    category = INTRADAY_CATEGORIES.get(period)
    if category is None:
        return []
    product = product_of(symbol["code"])
    opt_product = option_product_of(symbol["code"])
    chain = [
        item for item in options
        if item["exchange"] == symbol["exchange"] and item["product"] == opt_product
    ]
    seen: set[str] = set()
    unique = []
    for item in chain:
        if item["name"] in seen:
            continue
        seen.add(item["name"])
        unique.append(item)
    chain = unique

    today = date.today()
    expiries = sorted({item["expiry"] for item in chain
                       if expiry_date(item["expiry"], symbol["exchange"]) > today})[:2]
    if not expiries:
        return []

    fut_market = FUTURES_MARKET[symbol["exchange"]]
    futures: dict[str, dict[str, float]] = {}
    latest_forward: dict[str, float] = {}
    for expiry in expiries:
        code = f"{product}{expiry[2:]}"
        futures[expiry] = intraday_closes(api, fut_market, code, category, blocks)
        values = sorted(futures[expiry].items())
        latest_forward[expiry] = values[-1][1] if values else 0.0

    strikes: dict[str, list[float]] = {}
    for expiry in expiries:
        strikes[expiry] = _pick_strikes(chain, expiry, latest_forward[expiry])

    option_closes: dict[tuple[str, str, float], dict[str, float]] = {}
    for expiry in expiries:
        for strike in strikes[expiry]:
            for cp in ("call", "put"):
                found = _option_code(chain, expiry, cp, strike)
                if found:
                    market, code = found
                    option_closes[(expiry, cp, strike)] = intraday_closes(api, market, code, category, blocks)

    stamps = sorted(set().union(*(set(futures[e]) for e in expiries)))
    rows: list[dict[str, Any]] = []
    for stamp in stamps:
        available: list[tuple[float, float, float]] = []
        iv_by_expiry: dict[str, float] = {}
        for expiry in expiries:
            f = futures[expiry].get(stamp, 0.0)
            if not f or not strikes[expiry]:
                continue
            strike = min(strikes[expiry], key=lambda k: abs(k - f))
            call_px = option_closes.get((expiry, "call", strike), {}).get(stamp, 0.0)
            put_px = option_closes.get((expiry, "put", strike), {}).get(stamp, 0.0)
            t = _time_to_expiry(expiry, stamp, symbol["exchange"])
            if t <= 0 or not (call_px > 0 or put_px > 0):
                continue
            if strike >= f and call_px > 0:
                iv = implied_vol(call_px, f, strike, t, True)
            elif strike < f and put_px > 0:
                iv = implied_vol(put_px, f, strike, t, False)
            else:
                iv = implied_vol(call_px or put_px, f, strike, t, strike >= f)
            if not math.isfinite(iv):
                continue
            available.append((t, iv * iv, iv))
            iv_by_expiry[expiry] = iv

        if not available:
            continue
        if len(available) == 1:
            var30 = available[0][1]
        else:
            (t1, v1, _), (t2, v2, _) = available[0], available[1]
            if t1 < 7 / 365 or t2 <= 30 / 365:
                var30 = v2
            elif t1 <= 30 / 365 < t2:
                weight = (t2 - 30 / 365) / (t2 - t1)
                var30 = weight * v1 + (1 - weight) * v2
            else:
                var30 = v1

        rows.append({
            "symbol": symbol["code"],
            "period": period,
            "time": stamp,
            "ts": trading_ts(stamp),
            "vix": 100 * math.sqrt(max(0.0, var30)),
            "iv_near": round(iv_by_expiry[expiries[0]] * 100, 2) if expiries[0] in iv_by_expiry else None,
            "iv_next": round(iv_by_expiry[expiries[1]] * 100, 2) if len(expiries) > 1 and expiries[1] in iv_by_expiry else None,
            "expiry_near": expiries[0],
            "expiry_next": expiries[1] if len(expiries) > 1 else None,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        })

    for key in ("vix", "iv_near", "iv_next"):
        values = [r[key] for r in rows if r[key] is not None]
        smoothed = iter(_smooth_intraday(values))
        for row in rows:
            if row[key] is not None:
                row[key] = round(next(smoothed), 2)
    # 个别 bar 期权无有效报价时沿用上一个值，避免叠加线断成碎段。
    last: dict[str, float] = {}
    for row in rows:
        for key in ("vix", "iv_near", "iv_next"):
            value = row[key]
            if value is not None:
                last[key] = value
            elif key in last:
                row[key] = last[key]
    return rows


class VixStore:
    def __init__(self, path=config.DB_PATH) -> None:
        self.path = str(path)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
            conn.execute("""CREATE TABLE IF NOT EXISTS vix_daily (
                   symbol TEXT NOT NULL, date TEXT NOT NULL, ts INTEGER NOT NULL,
                   vix REAL NOT NULL, iv_near REAL, iv_next REAL,
                   expiry_near TEXT, expiry_next TEXT, updated_at TEXT,
                   PRIMARY KEY(symbol, date))""")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_vix ON vix_daily(symbol, date)")
            conn.execute("""CREATE TABLE IF NOT EXISTS vix_intraday (
                   symbol TEXT NOT NULL, period TEXT NOT NULL, time TEXT NOT NULL, ts INTEGER NOT NULL,
                   vix REAL NOT NULL, iv_near REAL, iv_next REAL,
                   expiry_near TEXT, expiry_next TEXT, updated_at TEXT,
                   PRIMARY KEY(symbol, period, time))""")
            conn.execute("CREATE INDEX IF NOT EXISTS ix_vix_intraday ON vix_intraday(symbol, period, ts)")
            conn.commit()
            self._conn = conn
        return self._conn

    def upsert(self, rows: Iterable[dict[str, Any]]) -> None:
        payload = [(
            r["symbol"], r["date"], r["ts"], r["vix"], r.get("iv_near"), r.get("iv_next"),
            r.get("expiry_near"), r.get("expiry_next"), r.get("updated_at"),
        ) for r in rows]
        if not payload:
            return
        with self._lock:
            self._db().executemany(
                """INSERT OR REPLACE INTO vix_daily
                   (symbol,date,ts,vix,iv_near,iv_next,expiry_near,expiry_next,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                payload,
            )
            self._conn.commit()

    def series(self, symbol: str, days: int = 260) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db().execute(
                """SELECT date, ts, vix, iv_near, iv_next, expiry_near, expiry_next FROM (
                       SELECT * FROM vix_daily WHERE symbol=? ORDER BY date DESC LIMIT ?)
                   ORDER BY date ASC""",
                (symbol.upper(), days),
            ).fetchall()
        keys = ("date", "ts", "vix", "iv_near", "iv_next", "expiry_near", "expiry_next")
        return [dict(zip(keys, row)) for row in rows]

    def upsert_intraday(self, rows: Iterable[dict[str, Any]]) -> None:
        payload = [(
            r["symbol"], r["period"], r["time"], r["ts"], r["vix"], r.get("iv_near"),
            r.get("iv_next"), r.get("expiry_near"), r.get("expiry_next"), r.get("updated_at"),
        ) for r in rows]
        if not payload:
            return
        with self._lock:
            self._db().executemany(
                """INSERT OR REPLACE INTO vix_intraday
                   (symbol,period,time,ts,vix,iv_near,iv_next,expiry_near,expiry_next,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                payload,
            )
            self._conn.commit()

    def series_intraday(self, symbol: str, period: str, limit: int = 2000) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db().execute(
                """SELECT time, ts, vix, iv_near, iv_next, expiry_near, expiry_next FROM (
                       SELECT * FROM vix_intraday WHERE symbol=? AND period=?
                       ORDER BY ts DESC LIMIT ?)
                   ORDER BY ts ASC""",
                (symbol.upper(), period, limit),
            ).fetchall()
        keys = ("time", "ts", "vix", "iv_near", "iv_next", "expiry_near", "expiry_next")
        return [dict(zip(keys, row)) for row in rows]

    def latest_all(self) -> list[dict[str, Any]]:
        with self._lock:
            symbols = [r[0] for r in self._db().execute("SELECT DISTINCT symbol FROM vix_daily").fetchall()]
        out: list[dict[str, Any]] = []
        for symbol in symbols:
            rows = self.series(symbol, 2)
            if not rows:
                continue
            last = rows[-1]
            prev = rows[-2]["vix"] if len(rows) > 1 else last["vix"]
            out.append({**last, "symbol": symbol, "prev_vix": prev, "change": round(last["vix"] - prev, 2)})
        return sorted(out, key=lambda item: item["vix"], reverse=True)


vix_store = VixStore()


def ensure_series(symbol: dict[str, Any], days: int = 260) -> list[dict[str, Any]]:
    rows = vix_store.series(symbol["code"], days)
    if len(rows) >= 2:
        return rows
    api, _ = connect()
    try:
        options = scan_options(api)
        computed = compute_symbol(api, symbol, options, days)
    finally:
        try:
            api.disconnect()
        except Exception:
            pass
    if computed:
        vix_store.upsert(computed)
        return vix_store.series(symbol["code"], days)
    return rows


def refresh_all(symbols: list[dict[str, Any]], days: int = 260, progress=None) -> dict[str, int]:
    api, _ = connect()
    stats = {"ok": 0, "empty": 0, "error": 0}
    try:
        options = scan_options(api)
        available = option_products(options)
        for index, symbol in enumerate(symbols, 1):
            if (symbol["exchange"], option_product_of(symbol["code"])) not in available:
                continue
            try:
                rows = compute_symbol(api, symbol, options, days)
                if rows:
                    vix_store.upsert(rows)
                    stats["ok"] += 1
                else:
                    stats["empty"] += 1
            except Exception:
                stats["error"] += 1
            if progress:
                progress(index, len(symbols), symbol["code"], stats)
    finally:
        try:
            api.disconnect()
        except Exception:
            pass
    return stats
