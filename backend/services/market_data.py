"""行情编排层：数据源 + 缓存 + 周期聚合，对外提供统一的历史/合约查询。"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

from .. import config
from ..adapters.base import DataSource
from ..domain.models import Bar, SymbolInfo
from ..domain.periods import PERIODS, aggregate
from .cache import BarCache


class MarketDataService:
    def __init__(self, source: DataSource, cache: BarCache) -> None:
        self.source = source
        self.cache = cache
        self._symbols: list[SymbolInfo] = []
        self._by_code: dict[str, SymbolInfo] = {}

    async def startup(self) -> None:
        await self.cache.load("__init__", "1m", 1)  # 触发建表
        try:
            cached = json.loads(config.SYMBOLS_CACHE.read_text(encoding="utf-8"))
            self._symbols = [SymbolInfo(**item) for item in cached]
        except (OSError, ValueError, TypeError):
            self._symbols = []
        if not self._symbols:
            await self.refresh_symbols()
        else:
            self._by_code = {s.code.upper(): s for s in self._symbols}

    async def refresh_symbols(self) -> list[SymbolInfo]:
        self._symbols = await self.source.symbols()
        self._by_code = {s.code.upper(): s for s in self._symbols}
        try:
            config.SYMBOLS_CACHE.write_text(
                json.dumps([s.to_dict() for s in self._symbols], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass
        return self._symbols

    @property
    def symbols(self) -> list[SymbolInfo]:
        return self._symbols

    def resolve(self, code: str) -> SymbolInfo:
        symbol = self._by_code.get(code.upper())
        if symbol is None:
            raise KeyError(f"未知合约: {code}")
        return symbol

    async def history(self, symbol: SymbolInfo, period: str, limit: int) -> list[Bar]:
        spec = PERIODS[period]
        limit = max(1, min(int(limit), 8000))
        key = symbol.key

        cached = await self.cache.load(key, period, limit)
        if len(cached) >= limit:
            return cached

        needed_source = limit
        if spec.group_minutes:
            needed_source = limit * (spec.group_minutes // spec.interval_minutes) + spec.group_minutes // spec.interval_minutes

        seed_period = spec.source if spec.group_minutes else period
        seed = await self.cache.load(key, seed_period, needed_source)
        source_bars: dict[int, Bar] = {b.ts: b for b in seed}
        start = 0
        pages = 0
        while len(source_bars) < needed_source and pages < 80:
            page = await self.source.bars(symbol, spec.source, start, config.BAR_PAGE_SIZE)
            if not page:
                break
            for bar in page:
                source_bars.setdefault(bar.ts, bar)
            start += len(page)
            pages += 1

        ordered = sorted(source_bars.values(), key=lambda b: b.ts)
        if spec.group_minutes and ordered:
            await self.cache.upsert(key, spec.source, ordered)
        result = aggregate(ordered, spec) if spec.group_minutes else ordered
        result = result[-limit:]
        if result:
            await self.cache.upsert(key, spec.name, result)
        return result

    async def refresh_latest(self, symbol: SymbolInfo, period: str) -> list[Bar]:
        """主动刷新最近若干根，避免缓存挡住新 K 线。"""
        spec = PERIODS[period]
        count = 320 if spec.group_minutes else 20
        rows = await self.source.bars(symbol, spec.source, 0, count)
        if not rows:
            return []
        ordered = sorted(rows, key=lambda b: b.ts)
        await self.cache.upsert(symbol.key, spec.source, ordered)
        final = aggregate(ordered, spec) if spec.group_minutes else ordered
        if spec.group_minutes and len(final) > 4:
            final = final[2:]  # 丢弃起始处可能不完整的桶
        await self.cache.upsert(symbol.key, spec.name, final)
        return final[-12:]

    async def latest_bar(self, symbol: SymbolInfo, period: str) -> Bar | None:
        bars = await self.history(symbol, period, 2)
        return bars[-1] if bars else None
