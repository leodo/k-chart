"""行情编排层：数据源 + 缓存 + 周期聚合，对外提供统一的历史/合约查询。

支持多个数据源：每个合约用 SymbolInfo.source 指定数据源（tdx=通达信 7727，
sina=新浪伦敦金/银现货），服务层只做路由，不关心协议细节。
"""
from __future__ import annotations

import json

from .. import config
from ..adapters.base import DataSource
from ..domain.models import Bar, SymbolInfo
from ..domain.periods import PERIODS, aggregate
from .cache import BarCache


class MarketDataService:
    def __init__(self, sources: dict[str, DataSource] | DataSource, cache: BarCache) -> None:
        if isinstance(sources, DataSource):
            self.sources: dict[str, DataSource] = {"tdx": sources}
        else:
            self.sources = dict(sources)
        if not self.sources:
            raise ValueError("至少需要一个数据源")
        self.default_source = next(iter(self.sources))
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
            return
        await self._merge_static_symbols()

    def source_for(self, symbol: SymbolInfo) -> DataSource:
        return self.sources.get(symbol.source) or self.sources[self.default_source]

    async def _static_symbols(self) -> list[SymbolInfo]:
        rows: list[SymbolInfo] = []
        for source in self.sources.values():
            if getattr(source, "static", False):
                rows.extend(await source.symbols())
        return rows

    async def _merge_static_symbols(self) -> None:
        """固定品种（伦敦金/银）不依赖通达信扫描，缓存里没有时补进去。"""
        extras = await self._static_symbols()
        if not extras:
            return
        merged = {s.code.upper(): s for s in self._symbols}
        changed = False
        for symbol in extras:
            if merged.get(symbol.code.upper()) != symbol:
                changed = True
            merged[symbol.code.upper()] = symbol
        self._symbols = sorted(merged.values(), key=lambda s: (s.exchange, s.code))
        self._by_code = {s.code.upper(): s for s in self._symbols}
        if changed:
            self._persist_symbols()

    async def refresh_symbols(self) -> list[SymbolInfo]:
        rows: list[SymbolInfo] = []
        tdx = self.sources.get("tdx") or self.sources[self.default_source]
        rows.extend(await tdx.symbols())
        rows.extend(await self._static_symbols())
        merged = {s.code.upper(): s for s in rows}
        self._symbols = sorted(merged.values(), key=lambda s: (s.exchange, s.code))
        self._by_code = {s.code.upper(): s for s in self._symbols}
        self._persist_symbols()
        return self._symbols

    def _persist_symbols(self) -> None:
        try:
            config.SYMBOLS_CACHE.write_text(
                json.dumps([s.to_dict() for s in self._symbols], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

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
        source = self.source_for(symbol)

        cached = await self.cache.load(key, period, limit)
        # 连续交易品种的东财快照有 10 分钟缓存，不能用「缓存已够 limit」直接返回，
        # 否则 F5 后会一直看到旧快照；交给适配器按 TTL 取新数据。
        if symbol.session != "global" and len(cached) >= limit:
            return cached

        needed_source = limit
        if spec.group_minutes:
            needed_source = limit * (spec.group_minutes // spec.interval_minutes) + spec.group_minutes // spec.interval_minutes

        seed_period = spec.source if spec.group_minutes else period
        seed = await self.cache.load(key, seed_period, needed_source)
        if symbol.session == "global":
            # 连续交易品种必须先拿适配器的最新快照；缓存只作为历史补充/失败回退，
            # 否则缓存已有 limit 根时 while 循环不会执行，F5 后永远看到旧数据。
            source_bars: dict[int, Bar] = {}
        else:
            source_bars = {b.ts: b for b in seed}
        start = 0
        pages = 0
        while len(source_bars) < needed_source and pages < 80:
            page = await source.bars(symbol, spec.source, start, config.BAR_PAGE_SIZE)
            if not page:
                break
            for bar in page:
                if symbol.session == "global":
                    # 现货以适配器最新快照为准，覆盖缓存里旧的其它数据源 K 线
                    source_bars[bar.ts] = bar
                else:
                    source_bars.setdefault(bar.ts, bar)
            start += len(page)
            pages += 1

        if symbol.session == "global" and seed:
            # 适配器只有最近 5 天/24 小时时，用缓存补更早的历史；同 ts 仍以适配器为准
            for bar in seed:
                source_bars.setdefault(bar.ts, bar)

        ordered = sorted(source_bars.values(), key=lambda b: b.ts)
        if spec.group_minutes and ordered:
            await self.cache.upsert(key, spec.source, ordered)
        result = aggregate(ordered, spec, symbol.session) if spec.group_minutes else ordered
        result = result[-limit:]
        if result:
            await self.cache.upsert(key, spec.name, result)
        return result

    async def refresh_latest(self, symbol: SymbolInfo, period: str) -> list[Bar]:
        """主动刷新最近若干根，避免缓存挡住新 K 线。

        伦敦金/银的实时 bar 由报价构造，历史快照低频拉取；这里直接跳过，
        避免用 30 秒前的快照把实时 bar 覆盖回去。
        """
        if symbol.session == "global":
            return []
        spec = PERIODS[period]
        source = self.source_for(symbol)
        count = 320 if spec.group_minutes else 20
        rows = await source.bars(symbol, spec.source, 0, count)
        if not rows:
            return []
        ordered = sorted(rows, key=lambda b: b.ts)
        await self.cache.upsert(symbol.key, spec.source, ordered)
        final = aggregate(ordered, spec, symbol.session) if spec.group_minutes else ordered
        if spec.group_minutes and len(final) > 4:
            final = final[2:]  # 丢弃起始处可能不完整的桶
        await self.cache.upsert(symbol.key, spec.name, final)
        return final[-12:]

    async def latest_bar(self, symbol: SymbolInfo, period: str) -> Bar | None:
        bars = await self.history(symbol, period, 2)
        return bars[-1] if bars else None
