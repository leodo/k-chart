"""数据源抽象：上层只依赖这个接口，替换数据源不需要改服务层。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Sequence

from ..domain.models import Bar, Quote, SymbolInfo


class DataSource(ABC):
    @abstractmethod
    async def symbols(self) -> list[SymbolInfo]:
        """返回全部可交易/可显示合约。"""

    @abstractmethod
    async def bars(self, symbol: SymbolInfo, native_period: str, start: int, count: int) -> list[Bar]:
        """按 start 偏移取原生周期 K 线，旧→新。"""

    @abstractmethod
    async def quote(self, symbol: SymbolInfo) -> Quote:
        """实时快照。"""
