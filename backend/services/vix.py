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


def _nth_weekday(year: int, month: int, n: int, from_end: bool = False,
                 before_day: int | None = None) -> date:
    """某月第 n 个工作日，from_end=True 时取倒数第 n 个（可限定某日之前）。"""
    last = calendar.monthrange(year, month)[1]
    day = (before_day or last) if from_end else 1
    step = -1 if from_end else 1
    count = 0
    while 1 <= day <= last:
        if date(year, month, day).weekday() < 5:
            count += 1
            if count == n:
                return date(year, month, day)
        day += step
    return date(year, month, day - step)


def expiry_date(expiry: str, exchange: str = "") -> date:
    """期权到期日。期权月份是标的期货的【交割月】，到期一般落在交割月前一个月。

    各交易所规则（节假日用工作日近似，误差几天、不影响 30 天口径）：
      - SHFE：交割月前一个月倒数第 5 个交易日（AU2612 → 2026-11-24）
      - DCE ：交割月前一个月第 12 个交易日
      - CZCE：交割月前一个月 15 日之前（含）的倒数第 3 个交易日
      - GFEX：交割月前一个月第 5 个交易日
      - CFFEX：合约月第三个周五
    """
    year, month = int(expiry[:4]), int(expiry[4:])
    if exchange == "CFFEX":
        first = date(year, month, 1)
        return first + timedelta(days=(4 - first.weekday()) % 7 + 14)
    if month == 1:
        y, m = year - 1, 12
    else:
        y, m = year, month - 1
    if exchange == "DCE":
        return _nth_weekday(y, m, 12)
    if exchange == "CZCE":
        return _nth_weekday(y, m, 3, from_end=True, before_day=15)
    if exchange == "GFEX":
        return _nth_weekday(y, m, 5)
    return _nth_weekday(y, m, 5, from_end=True)


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


def _forward_fill(closes: dict[str, float], stamps: list[str], max_gap: int = 6) -> dict[str, float]:
    """期权合约 minute/5m K 线只在有成交时才有记录，虚值一侧常常缺档。

    在同一交易日内用最近一笔成交价补齐缺失 bar（最多 max_gap 根），
    这样加权时不会突然改用远端的另一档，隐波曲线的跳动也更贴近盘口。
    """
    out: dict[str, float] = {}
    last = 0.0
    last_day = ""
    gap = 0
    for stamp in stamps:
        day = stamp[:10]
        price = closes.get(stamp, 0.0)
        if price > 0:
            last, last_day, gap = price, day, 0
        elif last > 0 and day == last_day and gap < max_gap:
            gap += 1
            out[stamp] = last
        else:
            last = 0.0
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
    """去单点脏价，保留真实方向变化（下跌抬 IV、反弹降 IV 不能被抹平）。

    两步：先用前后各 2 根的中位作参照，把偏离超过 12% 的孤立点替换掉；
    再做 3 点中位。不做跨 bar 的指数平滑，避免盘中突然的隐波变化被抹平。
    """
    if not values:
        return []
    robust: list[float] = []
    for i, value in enumerate(values):
        window = values[max(0, i - 2):min(len(values), i + 3)]
        local = statistics.median(window)
        if local > 0 and abs(value - local) / local > 0.12:
            robust.append(local)
        else:
            robust.append(value)
    med = [
        statistics.median(robust[max(0, i - 1):min(len(robust), i + 2)])
        for i in range(len(robust))
    ]
    # 只做三点中位去孤立毛刺，不再做 EWMA：盘中急涨急跌对应的隐波变化
    # 会被指数平滑抹掉，导致叠加线比真实盘口滞后半个到一个 bar。
    return med


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


def weighted_iv(f: float, t: float, strikes: list[float],
                closes: dict[tuple[str, float], dict[str, float]],
                stamp: str, expiry: str) -> float:
    """ATM 附近多档虚值期权加权 IV：单点脏价/行权价切换不再造成尖刺。

    - 每档只取虚值一侧（K>=F 取 call，K<F 取 put），避开深度实值结算滞后；
    - 以 1/(1+d²) 按到现价的距离衰减加权，近 ATM 权重大、远端虚值影响小；
    - 至少要有 1 档有效报价，否则返回 nan 由上层跳过的该时点。
    """
    if not strikes or t <= 0 or f <= 0:
        return float("nan")
    step = min((abs(strikes[i + 1] - strikes[i]) for i in range(len(strikes) - 1)), default=1.0)
    numerator = weight_sum = 0.0
    for k in strikes:
        call_px = closes.get(("call", k), {}).get(stamp, 0.0)
        put_px = closes.get(("put", k), {}).get(stamp, 0.0)
        # 只取虚值一侧：虚值缺价时宁可跳过这一档，也不能把实值价格
        # 按相反方向反推（旧代码把 put 当 call 算，会制造假的隐波尖刺）。
        if k >= f:
            if call_px <= 0:
                continue
            price, is_call = call_px, True
        else:
            if put_px <= 0:
                continue
            price, is_call = put_px, False
        iv = implied_vol(price, f, k, t, is_call)
        if not math.isfinite(iv):
            continue
        weight = 1.0 / (1.0 + ((k - f) / step) ** 2)
        numerator += weight * iv
        weight_sum += weight
    return numerator / weight_sum if weight_sum > 0 else float("nan")


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
    # 近月剩余不足 8 天时整段序列改用下一对到期（VIX 换月规则）：
    # 到期周时间价值趋零，IV 会失控并把叠加线拉出尖刺。
    candidates = sorted({item["expiry"] for item in chain
                         if (expiry_date(item["expiry"], symbol["exchange"]) - today).days > 0})
    expiries = [e for e in candidates
                if (expiry_date(e, symbol["exchange"]) - today).days > 8][:2]
    if len(expiries) < 2:
        expiries = candidates[:2]
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
            t = (expiry_date(expiry, symbol["exchange"]) - date.fromisoformat(day)).days / 365
            if t <= 0:
                continue
            per_expiry = {(cp, k): v for (e, cp, k), v in option_closes.items() if e == expiry}
            iv = weighted_iv(f, t, strikes[expiry], per_expiry, day, expiry)
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
    # 近月剩余不足 8 天时整段序列改用下一对到期（VIX 换月规则）：
    # 到期周时间价值趋零，IV 会失控并把叠加线拉出尖刺。
    candidates = sorted({item["expiry"] for item in chain
                         if (expiry_date(item["expiry"], symbol["exchange"]) - today).days > 0})
    expiries = [e for e in candidates
                if (expiry_date(e, symbol["exchange"]) - today).days > 8][:2]
    if len(expiries) < 2:
        expiries = candidates[:2]
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
    # 期权 5m K 线只有成交时才有记录；在当日邻 bar 内补齐最近成交价，
    # 避免某一档偶然无成交时权重突然跳到远端行权价。
    filled_closes: dict[tuple[str, str, float], dict[str, float]] = {}
    for key, series in option_closes.items():
        filled_closes[key] = _forward_fill(series, stamps, max_gap=2)
    rows: list[dict[str, Any]] = []
    for stamp in stamps:
        available: list[tuple[float, float, float]] = []
        iv_by_expiry: dict[str, float] = {}
        for expiry in expiries:
            f = futures[expiry].get(stamp, 0.0)
            if not f or not strikes[expiry]:
                continue
            t = _time_to_expiry(expiry, stamp, symbol["exchange"])
            if t <= 0:
                continue
            per_expiry = {(cp, k): v for (e, cp, k), v in filled_closes.items() if e == expiry}
            iv = weighted_iv(f, t, strikes[expiry], per_expiry, stamp, expiry)
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

    def delete_intraday(self, symbol: str, period: str | None = None) -> None:
        """删除旧缓存：算法修正后重算为空的品种不应继续显示过期序列。"""
        with self._lock:
            if period:
                self._db().execute(
                    "DELETE FROM vix_intraday WHERE symbol=? AND period=?",
                    (symbol.upper(), period),
                )
            else:
                self._db().execute(
                    "DELETE FROM vix_intraday WHERE symbol=?", (symbol.upper(),)
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
