"""k-chart 后端入口。只做 HTTP/WS 编排，业务逻辑在 services 层。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .adapters.spot import SpotAdapter
from .adapters.tdx_ext import TdxExtAdapter
from .domain.periods import is_supported
from .services.cache import BarCache
from .services.market_data import MarketDataService
from .services.realtime import RealtimeHub
from .services.vix import ensure_series, refresh_all, vix_store

log = logging.getLogger("k-chart")

adapter = TdxExtAdapter()
spot = SpotAdapter()
cache = BarCache()
service = MarketDataService({"tdx": adapter, "spot": spot}, cache)
hub = RealtimeHub(service)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO)
    log.info("探测通达信 7727 服务器...")
    good = await adapter.discover()
    log.info("可用服务器: %s", good)
    await service.startup()
    log.info("合约数量: %s", len(service.symbols))
    hub.start()
    yield
    await hub.stop()


app = FastAPI(title="k-chart", version="1.0", lifespan=lifespan)


@app.middleware("http")
async def no_cache(request: Request, call_next):
    """前端静态资源禁用缓存，避免改了 JS 后浏览器仍加载旧版本。"""
    response = await call_next(request)
    if not request.url.path.startswith("/api") and request.url.path != "/ws":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "symbols": len(service.symbols),
        "hosts": adapter._good,
    }


@app.get("/api/symbols")
async def symbols(exchange: str | None = None):
    rows = service.symbols
    if exchange:
        rows = [s for s in rows if s.exchange.upper() == exchange.upper()]
    return [s.to_dict() for s in rows]


@app.get("/api/bars")
async def bars(
    symbol: str = Query(..., description="合约代码，如 RBL9"),
    period: str = Query("5m", description="1m/5m/15m/30m/1h/4h/1d/1w"),
    limit: int = Query(config.DEFAULT_HISTORY_LIMIT, ge=1, le=8000),
):
    if not is_supported(period):
        return JSONResponse({"error": f"不支持的周期: {period}"}, status_code=400)
    try:
        info = service.resolve(symbol)
        data = await service.history(info, period, limit)
        return {
            "symbol": info.code,
            "name": info.name,
            "period": period,
            "digits": info.digits,
            "bars": [b.to_dict() for b in data],
        }
    except KeyError as exc:
        return JSONResponse({"error": str(exc)}, status_code=404)
    except Exception as exc:
        log.exception("获取 K 线失败")
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/api/vix/list")
async def vix_list():
    """全部品种的最新隐波指数；没有期权或尚未计算的品种 vix 为 null。"""
    rows = await asyncio.to_thread(vix_store.latest_all)
    latest = {row["symbol"]: row for row in rows}
    # 伦敦金/银没有国内期权链，不参与隐波总览
    products = [s for s in service.symbols if s.session == "cn"]
    return [
        {
            "symbol": s.code,
            "name": s.name,
            "exchange": s.exchange,
            "vix": latest.get(s.code, {}).get("vix"),
            "prev_vix": latest.get(s.code, {}).get("prev_vix"),
            "change": latest.get(s.code, {}).get("change"),
            "iv_near": latest.get(s.code, {}).get("iv_near"),
            "iv_next": latest.get(s.code, {}).get("iv_next"),
            "date": latest.get(s.code, {}).get("date"),
        }
        for s in products
    ]


@app.get("/api/vix/series")
async def vix_series(
    symbol: str = Query(..., description="项目品种代码，如 CUL9"),
    days: int = Query(260, ge=20, le=800),
    period: str = Query("1d", description="1d 为日线；5m/15m/30m/1h 为日内实算序列"),
):
    try:
        info = service.resolve(symbol)
        if info.session != "cn":
            return JSONResponse({"error": f"{info.name}没有期权链，无法计算隐波"}, status_code=400)
        if period in ("5m", "15m", "30m", "1h"):
            rows = await asyncio.to_thread(vix_store.series_intraday, info.code, period, 2000)
            return {"symbol": info.code, "name": info.name, "period": period, "series": rows}
        rows = await asyncio.to_thread(ensure_series, info.to_dict(), days)
        return {"symbol": info.code, "name": info.name, "period": "1d", "series": rows}
    except KeyError as exc:
        return JSONResponse({"error": str(exc)}, status_code=404)
    except Exception as exc:
        log.exception("获取隐波序列失败")
        return JSONResponse({"error": str(exc)}, status_code=502)


@app.get("/api/vix/refresh")
async def vix_refresh():
    """后台重算全部品种的隐波序列（仅国内期货品种）。"""
    products = [s for s in service.symbols if s.session == "cn"]
    task = asyncio.create_task(asyncio.to_thread(refresh_all, [s.to_dict() for s in products]))
    app.state.vix_refresh_task = task
    return {"started": True, "symbols": len(products)}


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "subscribe":
                symbol = str(msg.get("symbol") or "")
                period = str(msg.get("period") or "5m")
                if not is_supported(period):
                    await ws.send_json({"type": "error", "message": f"不支持的周期: {period}"})
                    continue
                try:
                    await hub.subscribe(ws, symbol, period)
                    await ws.send_json({"type": "subscribed", "symbol": symbol.upper(), "period": period})
                except KeyError as exc:
                    await ws.send_json({"type": "error", "message": str(exc)})
            elif msg.get("type") == "unsubscribe":
                hub.unsubscribe(ws)
    except WebSocketDisconnect:
        hub.unsubscribe(ws)
    except Exception:
        hub.unsubscribe(ws)


app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="frontend")
