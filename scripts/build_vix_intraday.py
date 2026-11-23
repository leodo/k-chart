"""批量预计算日内隐波序列，写入 bars.sqlite3 的 vix_intraday 表。

默认只算 30m（用户最常用且服务端数据量可控）；需要其它周期用 --period 指定。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import config  # noqa: E402
from backend.services.vix import (  # noqa: E402
    aggregate_intraday, compute_symbol_intraday_base, connect, option_product_of,
    option_products, scan_options, vix_store,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", default="30m", help="逗号分隔：5m,15m,30m,1h")
    parser.add_argument("--blocks", type=int, default=8, help="1 分钟源数据向前翻几页 700 根")
    parser.add_argument("--symbol", default="", help="只算单个品种，便于调试")
    args = parser.parse_args()

    periods = [p.strip() for p in args.period.split(",") if p.strip()]
    symbols = json.loads(config.SYMBOLS_CACHE.read_text(encoding="utf-8"))
    if args.symbol:
        symbols = [s for s in symbols if s["code"].upper() == args.symbol.upper()]

    started = time.time()
    api, host = connect()
    stats = {"ok": 0, "empty": 0, "error": 0}
    try:
        options = scan_options(api)
        available = option_products(options)
        print(f"服务器 {host}；周期 {','.join(periods)}；品种 {len(symbols)}", flush=True)
        for index, symbol in enumerate(symbols, 1):
            if (symbol["exchange"], option_product_of(symbol["code"])) not in available:
                continue
            # 1m 基底只算一次，再聚合出所有周期，避免每周期重复拉一遍期权 K 线。
            try:
                base = compute_symbol_intraday_base(api, symbol, options, args.blocks)
            except Exception as exc:
                stats["error"] += len(periods)
                print(f"  {symbol['code']} 1m 基底失败: {exc}", flush=True)
                continue
            for period in periods:
                rows = aggregate_intraday(base, period)
                if rows:
                    vix_store.upsert_intraday(rows)
                    stats["ok"] += 1
                else:
                    # 算法修订后若该品种算不出有效隐波，清掉旧版本缓存，
                    # 避免前端继续叠加一份错误的历史曲线。
                    vix_store.delete_intraday(symbol["code"], period)
                    stats["empty"] += 1
            if index % 10 == 0 or index == len(symbols):
                print(f"[{index}/{len(symbols)}] {symbol['code']} "
                      f"成功 {stats['ok']} / 空 {stats['empty']} / 错误 {stats['error']}", flush=True)
    finally:
        try:
            api.disconnect()
        except Exception:
            pass
    print("完成:", stats, "耗时", round(time.time() - started, 1), "秒", flush=True)


if __name__ == "__main__":
    main()
