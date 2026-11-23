# scripts/ — 自动支撑 / 压力线的离线校验工具

这些脚本只在开发时用，直接把 `frontend/js/indicators/helpers.js` 当 ES 模块加载，
不依赖浏览器；默认从本地后端（`start.bat` 起的 127.0.0.1:8765）取 K 线。

## MOS 指标校验（通达信公式移植）

```bat
node scripts\verify_mos.mjs                          :: 默认 RBL9 日线，含正弦行情冒烟
node scripts\verify_mos.mjs --period=5m --limit=1500
node scripts\verify_mos.mjs --json --out=scripts\_js.json   :: 导出各类标记的下标
.venv\Scripts\python.exe scripts\mos_reference.py 1d RBL9 800 scripts\_py.json
```

`mos_reference.py` 是同一套通达信公式的 **Python 独立实现**，用来和前端 `mos.js` 对拍：
两边输出的 ●底部结构 / ●顶部结构 / 时间 / ▲低点 / ▲高点 下标应当完全一致
（换手改坏下标对齐时最容易出问题）。

## 不变量回归（改算法后必跑）

```bat
node scripts\verify_channel.mjs                 :: 默认 RBL9 日线
node scripts\verify_channel.mjs --period=1h
node scripts\verify_channel.mjs scripts\bars_rbl9_1d.json   :: 用导出的 JSON
node scripts\smoke_params.mjs                   :: 极端/关闭类参数组合
```

`verify_channel.mjs` 检查三件事（就是这次修的三类问题）：

1. 每条线至少 2 个触点、触点跨度 ≥ 10 根（不再出现「只穿过一个点」的线）；
2. 绘制长度 = 触点跨度 + 两端外推，不会横穿整张图；
3. `count` 从 1 加到 12 是稳定的前缀关系：`+` 只追加更靠历史的线，`−` 只收掉最早的一条。

## 画图人工比对

```bat
:: 1) 计算并导出
node scripts\dump_lines.mjs auto scripts\lines.json 3 2 140
::    参数: <bars.json|auto> <out.json> [count] [side] [可见根数]
:: 2) 画成 PNG（纯标准库，无需 matplotlib）
.venv\Scripts\python.exe scripts\render_check.py scripts\lines.json scripts\check.png
```

## 端到端截图（Edge headless + CDP）

```bat
node scripts\e2e_shot.mjs scripts\shot.png --period=1d --side=2 --count=4 --recent=140
node scripts\e2e_shot.mjs scripts\shot.png --period=1d --actions=open-menu
node scripts\e2e_shot.mjs scripts\shot.png --period=1d --actions=off-all
node scripts\e2e_shot.mjs scripts\shot.png --actions=gear-outside
node scripts\e2e_shot.mjs scripts\shot.png --width=900 --height=760
```

会打开本地页面、设置自动线参数并截图，用来确认浏览器里的真实效果
（触点圆圈已移除、线长、加减线顺序、勾选状态、浮层点外关闭、工具栏换行）。

常用参数：`--width/--height` 窗口尺寸、`--period` 周期、`--recent` 只显示最近 N 根、
`--nofit` 保留切换周期后的默认缩放、`--actions` 见下：

| actions | 作用 |
| --- | --- |
| `open-menu` | 打开「自动线」菜单并截图 |
| `flow` | 依次勾选/取消 5 个开关，输出画线数与勾选状态 |
| `off-all` | 把所有 ☑ 取消，断言一条线都不画 |
| `gear-outside` / `settings-outside` | 点齿轮打开浮层、再点图表外，断言浮层关闭 |
| `open-more` | 窄屏点 ☰ 展开更多工具栏 |
| `realtime` | 等 3 秒看行情是否推送，再模拟一笔成交验证指标实时重算 |
| `measure` | 输出工具栏各项宽度与视口缩放（排查排版用） |

## 导出 K 线

```bat
.venv\Scripts\python.exe scripts\dump_bars.py 30:RBL9 1d 700 scripts\bars_rbl9_1d.json
```

`verify_channel.mjs --all` 会跑 `scripts/bars_*.json` 里的所有数据集。

## 商品期权链（通达信 7727）

```bat
:: 看项目里哪些品种有期权
.venv\Scripts\python.exe scripts\fetch_option_chain.py --list-covered

:: 拉沪铜 2701 到期、平值附近各 3 档的盘口
.venv\Scripts\python.exe scripts\fetch_option_chain.py --symbol CUL9 --expiry 2701 --quotes --around 3

:: 导出碳酸锂期权链到 JSON / CSV
.venv\Scripts\python.exe scripts\fetch_option_chain.py --symbol LCL9 --expiry 2701 --quotes --json data\lc_chain.json --csv data\lc_chain.csv
```

期权市场来自通达信扩展行情：4=郑商所、5=大商所、6=上期所、7=中金所、67=广期所。
合约名格式 `CU2701-C-79000`，按产品代码 + 交易所映射到 `symbols.json` 里的 `CUL9` 等加权合约。
`pytdx` 的 `get_instrument_quote_list` 未实现，盘口按合约逐笔取；收盘后部分合约只有昨收，没有买一/卖一。

## 隐波指数（近似 VIX）

```bat
:: 批量预计算全部品种的隐波日线，写入 data/bars.sqlite3 的 vix_daily 表
.venv\Scripts\python.exe scripts\build_vix.py

:: 预计算日内隐波（默认 30m；5m/15m/30m/1h 用期权与期货同期日内 K 线实算）
.venv\Scripts\python.exe scripts\build_vix_intraday.py
.venv\Scripts\python.exe scripts\build_vix_intraday.py --period 5m,15m,30m,1h

:: 通用页面截图 + JS 错误收集（前端联调用）
node scripts\shot_page.mjs scripts\shots\vix.png --url=http://127.0.0.1:8765/vix.html --wait=3000
```

页面入口：
- `http://127.0.0.1:8765/vix.html` 全品种隐波列表，点表头排序、点行看走势图；
- 普通 K 线页工具栏「隐波」按钮：把 30 天隐波叠加到主图，用独立右轴，不改变价格轴范围；
- 周期对齐：日线按交易日、周线按 ISO 周；日内 5m/15m/30m/1h **优先用同周期期权与期货 K 线实算的隐波**（按交易时序时间戳对齐），能反映盘中「下跌隐波上升、反弹隐波回落」；只有该周期没有实算数据时才退回日线插值。

接口：`/api/vix/list`、`/api/vix/series?symbol=CUL9&period=30m`、`/api/vix/refresh`（后台重算全部日线）。

算法要点（2026-11-23 修正，此前到期日错误导致隐波数值偏低约 3 倍）：
- **期权到期日按交易所真实规则**（期权月份是标的期货交割月，到期落在前一个月）：SHFE=前一月倒数第 5 个工作日（AU2612→11-24）、DCE=第 12 个、CZCE=15 日前倒数第 3 个、GFEX=第 5 个、CFFEX=合约月第三个周五。此前统一用「合约月 5 号」是错的。
- **近月剩余 < 8 天自动换月**到下一对到期（VIX 换月规则），避免到期周时间价值趋零让 IV 失控。
- 每个到期取 ATM 附近 5 档行权价，逐根按当根期货价取虚值一侧、经 Black-76 反推 IV，**按 1/(1+d²) 距离加权平均**（近 ATM 权重大），再按日历天把两组方差插值到 30 天，100×√方差。股指期权代码映射 IM→MO、IF→IO、IH→HO。
- 去噪：偏离局部中位 12% 以上的孤立脏价先替换，再做 3 点中位；日内不再做跨 bar EWMA，避免盘中急涨急跌对应的隐波变化被抹平。日线仍用 5 日中位 + EWMA。
- 虚值缺价处理：只取虚值一侧反推 IV；虚值一侧无成交时跳过该档，不再把实值价格当虚值使用（旧逻辑会制造假的隐波尖刺）。同一交易日内最多沿用最近 2 根 bar 的成交价补缺档。重算为空的品种会清理旧缓存，避免残留错误曲线。
- 口径校验：沪金加权 30m 隐波约 **28~32**（OpenVlab 同期显示 33.12），沪铜约 27、股指约 41、螺纹约 11，量级一致。这是自己算的近似 VIX，不是交易所官方指数，也不等同于软件商自有口径：OpenVlab 的曲线更接近「近月合约实时买卖盘口隐波」，本项目数据源只有历史逐笔成交 K 线，无法复现其盘口瞬间跳变，因此走势细节（尤其是价格急拉时的尖峰幅度）会有差异，仅作横向比较参考。
切换合约时各视图保持柱宽与屏幕中间那根 K 线的相对位置；开高低收图例靠右上，隐波数值排在其下一行。
