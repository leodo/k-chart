"""全局配置：只放不依赖业务的参数，所有模块从这里读取。"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SYMBOLS_CACHE = DATA_DIR / "symbols.json"
DB_PATH = DATA_DIR / "bars.sqlite3"
FRONTEND_DIR = ROOT / "frontend"

# 用户本机通达信配置，7727 扩展行情服务器就从这里读
TDX_CONNECT_CFG = Path(
    os.getenv("TDX_CONNECT_CFG", r"D:\Program Trade\tdx\connect.cfg")
)
TDX_PORT = 7727

HOST_PROBE_TIMEOUT = float(os.getenv("TDX_PROBE_TIMEOUT", "5"))
POOL_SIZE = int(os.getenv("TDX_POOL_SIZE", "3"))
BAR_PAGE_SIZE = 800
REALTIME_POLL_SECONDS = float(os.getenv("REALTIME_POLL_SECONDS", "2"))
BAR_REFRESH_SECONDS = float(os.getenv("BAR_REFRESH_SECONDS", "30"))
DEFAULT_HISTORY_LIMIT = int(os.getenv("DEFAULT_HISTORY_LIMIT", "1500"))

FALLBACK_HOSTS = ("116.205.143.214", "112.74.214.43", "120.25.218.6")

DATA_DIR.mkdir(parents=True, exist_ok=True)
