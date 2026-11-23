"""从通达信 7727 扩展行情拉取本项目品种的期权链。

用法示例：
  .venv\\Scripts\\python.exe scripts\\fetch_option_chain.py --list-covered
  .venv\\Scripts\\python.exe scripts\\fetch_option_chain.py --symbol CUL9 --expiry 2701 --quotes
  .venv\\Scripts\\python.exe scripts\\fetch_option_chain.py --symbol LCL9 --quotes --json data\\lc_chain.json
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import config  # noqa: E402
from backend.adapters.tdx_ext import read_hosts  # noqa: E402

try:
    from pytdx.exhq import TdxExHq_API
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit("请先安装 pytdx：.venv\\Scripts\\python.exe -m pip install pytdx") from exc


OPTION_MARKETS = {4: "CZCE", 5: "DCE", 6: "SHFE", 7: "CFFEX", 67: "GFEX"}
FUTURES_MARKET = {"CZCE": 28, "DCE": 29, "SHFE": 30, "CFFEX": 47, "GFEX": 66}
NAME_RE = re.compile(r"^([A-Za-z]+)(\d{4})-([CP])-(\d+(?:\.\d+)?)$")


def connect() -> tuple[Any, str]:
    api = TdxExHq_API()
    for host in read_hosts(config.TDX_CONNECT_CFG):
        try:
            api.connect(host, config.TDX_PORT, time_out=config.HOST_PROBE_TIMEOUT)
            if api.get_markets():
                return api, host
        except Exception:
            continue
    raise ConnectionError("没有可用的通达信 7727 服务器")


def scan_options(api: Any) -> list[dict[str, Any]]:
    total = int(api.get_instrument_count() or 0)
    out: list[dict[str, Any]] = []
    for start in range(0, total, 1000):
        for row in api.get_instrument_info(start, 1000) or []:
            market = int(row.get("market") or 0)
            if market not in OPTION_MARKETS:
                continue
            name = str(row.get("name") or "")
            matched = NAME_RE.match(name)
            if not matched:
                continue
            product, yymm, cp, strike = matched.groups()
            out.append(
                {
                    "code": str(row.get("code") or ""),
                    "name": name,
                    "market": market,
                    "exchange": OPTION_MARKETS[market],
                    "product": product.upper(),
                    "expiry": f"20{yymm[:2]}{yymm[2:]}",
                    "cp": "call" if cp == "C" else "put",
                    "strike": float(strike),
                }
            )
    return out


def load_symbols() -> list[dict[str, Any]]:
    return json.loads(config.SYMBOLS_CACHE.read_text(encoding="utf-8"))


def product_of(symbol: dict[str, Any]) -> str:
    code = str(symbol["code"]).upper()
    return code[:-2] if code.endswith("L9") else code


def resolve_symbol(code: str, symbols: list[dict[str, Any]]) -> dict[str, Any]:
    for item in symbols:
        if str(item["code"]).upper() == code.upper():
            return item
    raise KeyError(f"未知项目品种: {code}")


def chain_for(symbol: dict[str, Any], options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    product = product_of(symbol)
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in options:
        if item["exchange"] != symbol["exchange"] or item["product"] != product:
            continue
        if item["name"] in seen:
            continue
        seen.add(item["name"])
        result.append(item)
    return result


def print_coverage(symbols: list[dict[str, Any]], options: list[dict[str, Any]]) -> None:
    counts = Counter((item["exchange"], item["product"]) for item in options)
    covered: list[tuple[str, str, str, int]] = []
    for symbol in symbols:
        count = counts.get((symbol["exchange"], product_of(symbol)), 0)
        if count:
            covered.append((symbol["code"], symbol["name"], symbol["exchange"], count))
    print(f"项目品种 {len(symbols)} 个，其中有挂牌期权 {len(covered)} 个：")
    for code, name, exchange, count in covered:
        print(f"  {code:<8} {name:<12} {exchange:<6} {count:>5} 个期权合约")
    missing = [s for s in symbols if (s["exchange"], product_of(s)) not in counts]
    print(f"\n无期权品种 {len(missing)} 个：")
    print("  " + "、".join(f"{s['name']}({s['code']})" for s in missing))


def first_quote(api: Any, market: int, code: str) -> dict[str, Any] | None:
    rows = api.get_instrument_quote(market, code) or []
    return rows[0] if rows else None


def underlying_price(api: Any, symbol: dict[str, Any], expiry: str) -> float:
    code = f"{product_of(symbol)}{expiry[2:]}"
    row = first_quote(api, FUTURES_MARKET[symbol["exchange"]], code)
    if not row:
        return 0.0
    for field in ("price", "pre_close", "open"):
        value = float(row.get(field) or 0)
        if value > 0:
            return value
    return 0.0


def fetch_quotes(
    api: Any,
    symbol: dict[str, Any],
    chain: list[dict[str, Any]],
    expiry: str,
    around: int,
) -> list[dict[str, Any]]:
    selected = [item for item in chain if item["expiry"] == expiry]
    if not selected:
        raise SystemExit(f"{symbol['code']} 没有 {expiry} 到期的期权")
    spot = underlying_price(api, symbol, expiry)
    if around and spot > 0:
        by_cp: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in selected:
            by_cp[item["cp"]].append(item)
        picked: list[dict[str, Any]] = []
        for group in by_cp.values():
            group.sort(key=lambda item: abs(item["strike"] - spot))
            picked.extend(group[:around])
        selected = sorted(picked, key=lambda item: (item["cp"], item["strike"]))

    rows: list[dict[str, Any]] = []
    for item in selected:
        quote = first_quote(api, item["market"], item["code"]) or {}
        bid = float(quote.get("bid1") or 0)
        ask = float(quote.get("ask1") or 0)
        last = float(quote.get("price") or 0)
        mid = round((bid + ask) / 2, 4) if bid > 0 and ask > 0 else (last or float(quote.get("pre_close") or 0))
        rows.append(
            {
                **item,
                "bid": bid,
                "ask": ask,
                "last": last,
                "mid": mid,
                "volume": float(quote.get("zongliang") or 0),
                "oi": float(quote.get("chicang") or 0),
            }
        )
    return rows


def print_chain(symbol: dict[str, Any], chain: list[dict[str, Any]], rows: list[dict[str, Any]], expiry: str) -> None:
    expiries = sorted({item["expiry"] for item in chain})
    print(f"{symbol['code']} {symbol['name']} | 期权合约 {len(chain)} 个 | 到期月份 {' '.join(expiries)}")
    if not rows:
        print("（加 --quotes 查看盘口）")
        return
    print(f"\n到期 {expiry} 合约（标的期货价格已用于筛选平值附近行权价）")
    print(f"{'合约':<20} {'CP':<5} {'行权价':>10} {'买价':>9} {'卖价':>9} {'中间价':>9} {'成交量':>8} {'持仓':>8} {'TDX代码':<10}")
    for row in rows:
        print(
            f"{row['name']:<20} {row['cp']:<5} {row['strike']:>10.1f} "
            f"{row['bid']:>9.1f} {row['ask']:>9.1f} {row['mid']:>9.1f} "
            f"{row['volume']:>8.0f} {row['oi']:>8.0f} {row['code']:<10}"
        )


def save(rows: list[dict[str, Any]], json_path: str | None, csv_path: str | None) -> None:
    if json_path:
        Path(json_path).write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已写入 JSON: {json_path}")
    if csv_path:
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["code"])
            writer.writeheader()
            writer.writerows(rows)
        print(f"已写入 CSV: {csv_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="拉取项目品种的商品期权链")
    parser.add_argument("--symbol", help="项目品种代码，如 CUL9 / LCL9 / RBL9")
    parser.add_argument("--expiry", help="到期月份 YYMM 或 YYYYMM，如 2701")
    parser.add_argument("--quotes", action="store_true", help="抓取盘口、成交量、持仓量")
    parser.add_argument("--around", type=int, default=6, help="每个看涨/看跌取平值附近几档，默认 6")
    parser.add_argument("--list-covered", action="store_true", help="列出项目中有期权的品种")
    parser.add_argument("--json", dest="json_path", help="导出 JSON 文件路径")
    parser.add_argument("--csv", dest="csv_path", help="导出 CSV 文件路径")
    args = parser.parse_args()

    api, host = connect()
    try:
        print(f"通达信服务器: {host}")
        options = scan_options(api)
        symbols = load_symbols()
        if args.list_covered or not args.symbol:
            print_coverage(symbols, options)
            return
        symbol = resolve_symbol(args.symbol, symbols)
        chain = chain_for(symbol, options)
        if not chain:
            raise SystemExit(f"{symbol['code']} {symbol['name']} 没有挂牌期权")
        expiries = sorted({item["expiry"] for item in chain})
        if args.expiry:
            expiry = f"20{args.expiry[:2]}{args.expiry[2:]}" if len(args.expiry) == 4 else args.expiry
        else:
            expiry = expiries[0]
        rows = fetch_quotes(api, symbol, chain, expiry, args.around) if args.quotes else []
        print_chain(symbol, chain, rows, expiry)
        if rows:
            save(rows, args.json_path, args.csv_path)
    finally:
        try:
            api.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    main()
