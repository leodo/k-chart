"""批量预计算项目全部品种的隐波指数日线，写入 bars.sqlite3 的 vix_daily 表。"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import config  # noqa: E402
from backend.services.vix import refresh_all  # noqa: E402


def progress(done: int, total: int, code: str, stats: dict) -> None:
    if done % 10 == 0 or done == total:
        print(f"[{done}/{total}] {code}  成功 {stats['ok']} / 空 {stats['empty']} / 错误 {stats['error']}", flush=True)


async def main() -> None:
    symbols = json.loads(config.SYMBOLS_CACHE.read_text(encoding="utf-8"))
    print(f"开始计算 {len(symbols)} 个品种的隐波序列…", flush=True)
    stats = await asyncio.to_thread(refresh_all, symbols, 260, progress)
    print("完成:", stats, flush=True)


if __name__ == "__main__":
    asyncio.run(main())
