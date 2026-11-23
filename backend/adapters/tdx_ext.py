"""通达信 7727 扩展行情适配器。

职责边界：
- 只负责连接、协议、代码表与原始 K 线/快照；
- 不做周期聚合、不做缓存、不做业务编排。
"""
from __future__ import annotations

import asyncio
import configparser
import queue
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from pytdx.exhq import TdxExHq_API
from pytdx.params import TDXParams

from .. import config
from ..domain.models import Bar, Quote, SymbolInfo
from .base import DataSource

EXCHANGE_BY_MARKET = {
    28: "CZCE",
    29: "DCE",
    30: "SHFE",
    47: "CFFEX",
    66: "GFEX",
}

CATEGORY_BY_PERIOD = {
    "1m": TDXParams.KLINE_TYPE_EXHQ_1MIN,
    "5m": TDXParams.KLINE_TYPE_5MIN,
    "15m": TDXParams.KLINE_TYPE_15MIN,
    "30m": TDXParams.KLINE_TYPE_30MIN,
    "1h": TDXParams.KLINE_TYPE_1HOUR,
    "1d": TDXParams.KLINE_TYPE_DAILY,
}


@dataclass(slots=True)
class _Client:
    api: Any
    host: str
    created: float


def read_hosts(cfg_path: Path) -> list[str]:
    """从通达信 connect.cfg 的 [DSHOST] 读取扩展行情服务器。"""
    hosts: list[str] = []
    try:
        parser = configparser.ConfigParser()
        parser.read(cfg_path, encoding="gbk")
        if parser.has_section("DSHOST"):
            for key, value in parser.items("DSHOST"):
                if key.startswith("ipaddress"):
                    value = value.strip()
                    if value and value not in hosts:
                        hosts.append(value)
    except (OSError, configparser.Error):
        pass
    for host in config.FALLBACK_HOSTS:
        if host not in hosts:
            hosts.append(host)
    return hosts


def _probe(host: str) -> str | None:
    """返回可用 host；协议层拿不到市场列表的机器视为不可用。"""
    api: Any = None
    try:
        api = TdxExHq_API()
        api.connect(host, config.TDX_PORT, time_out=config.HOST_PROBE_TIMEOUT)
        markets = api.get_markets()
        return host if markets else None
    except Exception:
        return None
    finally:
        if api is not None:
            try:
                api.disconnect()
            except Exception:
                pass


class TdxExtAdapter(DataSource):
    def __init__(self, cfg_path: Path | None = None) -> None:
        self.cfg_path = cfg_path or config.TDX_CONNECT_CFG
        self._hosts = read_hosts(self.cfg_path)
        self._good: list[str] = []
        self._pool: queue.Queue[_Client] = queue.Queue(maxsize=config.POOL_SIZE)
        self._symbols_cache: list[SymbolInfo] | None = None

    async def discover(self) -> list[str]:
        """并测所有服务器，把协议层真正可用的排到最前。"""
        loop = asyncio.get_running_loop()
        results = await asyncio.gather(
            *(loop.run_in_executor(None, _probe, h) for h in self._hosts),
            return_exceptions=True,
        )
        good = [r for r in results if isinstance(r, str) and r]
        self._good = good or list(config.FALLBACK_HOSTS)
        return self._good

    def _connect(self) -> _Client:
        last_error: Exception | None = None
        for host in self._good or self._hosts:
            api: Any = None
            try:
                api = TdxExHq_API(heartbeat=True)
                api.connect(host, config.TDX_PORT, time_out=config.HOST_PROBE_TIMEOUT)
                if api.get_markets():
                    return _Client(api=api, host=host, created=time.time())
            except Exception as exc:
                last_error = exc
                if api is not None:
                    try:
                        api.disconnect()
                    except Exception:
                        pass
        raise ConnectionError(f"没有可用的通达信 7727 服务器: {last_error}")

    @contextmanager
    def _borrow(self):
        try:
            client = self._pool.get_nowait()
        except queue.Empty:
            client = self._connect()
        try:
            yield client.api
        except Exception:
            try:
                client.api.disconnect()
            except Exception:
                pass
            raise
        else:
            try:
                self._pool.put_nowait(client)
            except queue.Full:
                try:
                    client.api.disconnect()
                except Exception:
                    pass

    async def _run(self, fn: Callable[[Any], Any]) -> Any:
        return await asyncio.to_thread(lambda: self._call(fn))

    def _call(self, fn: Callable[[Any], Any]) -> Any:
        with self._borrow() as api:
            return fn(api)

    async def symbols(self) -> list[SymbolInfo]:
        if self._symbols_cache is not None:
            return self._symbols_cache

        def scan(api: Any) -> list[SymbolInfo]:
            total = int(api.get_instrument_count() or 0)
            found: list[SymbolInfo] = []
            for start in range(0, total, 1000):
                rows = api.get_instrument_info(start, 1000) or []
                for row in rows:
                    code = str(row.get("code") or "")
                    market = int(row.get("market") or 0)
                    if code.upper().endswith("L9") and market in EXCHANGE_BY_MARKET:
                        found.append(
                            SymbolInfo(
                                code=code,
                                market=market,
                                name=str(row.get("name") or code),
                                exchange=EXCHANGE_BY_MARKET[market],
                            )
                        )
            return found

        result = await self._run(scan)
        self._symbols_cache = sorted(result, key=lambda s: (s.exchange, s.code))
        return self._symbols_cache

    async def bars(self, symbol: SymbolInfo, native_period: str, start: int, count: int) -> list[Bar]:
        category = CATEGORY_BY_PERIOD[native_period]

        def fetch(api: Any) -> list[Bar]:
            rows = api.get_instrument_bars(category, symbol.market, symbol.code, start, count) or []
            return [Bar.from_tdx(row) for row in rows]

        return await self._run(fetch)

    async def quote(self, symbol: SymbolInfo) -> Quote:
        def fetch(api: Any) -> Quote:
            rows = api.get_instrument_quote(symbol.market, symbol.code) or []
            if not rows:
                raise LookupError(f"无报价: {symbol.code}")
            q = rows[0]
            return Quote(
                price=float(q.get("price") or 0),
                open=float(q.get("open") or 0),
                high=float(q.get("high") or 0),
                low=float(q.get("low") or 0),
                pre_close=float(q.get("pre_close") or 0),
                volume=float(q.get("zongliang") or 0),
                oi=float(q.get("chicang") or 0),
                bid=float(q.get("bid1") or 0),
                ask=float(q.get("ask1") or 0),
                ts=int(datetime.now().timestamp() * 1000),
            )

        return await self._run(fetch)
