"""SQLite 增量缓存：只负责存取，不负责取数或聚合。"""
from __future__ import annotations

import asyncio
import sqlite3
import threading
from typing import Iterable

from ..config import DB_PATH
from ..domain.models import Bar


class BarCache:
    def __init__(self, path=DB_PATH) -> None:
        self.path = str(path)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.execute(
                """CREATE TABLE IF NOT EXISTS bars (
                       symbol TEXT NOT NULL,
                       period TEXT NOT NULL,
                       ts INTEGER NOT NULL,
                       time TEXT NOT NULL,
                       open REAL, high REAL, low REAL, close REAL,
                       volume REAL, oi REAL,
                       PRIMARY KEY(symbol, period, ts))"""
            )
            conn.execute("CREATE INDEX IF NOT EXISTS ix_bars ON bars(symbol, period, ts)")
            conn.commit()
            self._conn = conn
        return self._conn

    async def load(self, symbol: str, period: str, limit: int) -> list[Bar]:
        def work() -> list[Bar]:
            with self._lock:
                rows = self._db().execute(
                    """SELECT time, ts, open, high, low, close, volume, oi
                       FROM (SELECT * FROM bars WHERE symbol=? AND period=? ORDER BY ts DESC LIMIT ?)
                       ORDER BY ts ASC""",
                    (symbol, period, limit),
                ).fetchall()
            return [Bar(*row) for row in rows]

        return await asyncio.to_thread(work)

    async def upsert(self, symbol: str, period: str, bars: Iterable[Bar]) -> None:
        payload = [
            (symbol, period, b.ts, b.time, b.open, b.high, b.low, b.close, b.volume, b.oi)
            for b in bars
        ]
        if not payload:
            return

        def work() -> None:
            with self._lock:
                self._db().executemany(
                    """INSERT OR REPLACE INTO bars
                       (symbol, period, ts, time, open, high, low, close, volume, oi)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    payload,
                )
                self._conn.commit()

        await asyncio.to_thread(work)
