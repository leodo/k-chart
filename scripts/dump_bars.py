"""导出 K 线到 JSON，供前端指标算法的离线回归脚本使用（只读，不改数据）。

用法:
    .venv\\Scripts\\python.exe scripts\\dump_bars.py RBL9 1d 800 scripts\\bars_rbl9_1d.json
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "bars.sqlite3"


def main() -> None:
    symbol = sys.argv[1] if len(sys.argv) > 1 else "RBL9"
    period = sys.argv[2] if len(sys.argv) > 2 else "1d"
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 800
    out = Path(sys.argv[4]) if len(sys.argv) > 4 else ROOT / "scripts" / "bars.json"

    con = sqlite3.connect(DB)
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
    print("tables:", tables)
    print("schema:", con.execute(f"select sql from sqlite_master where name='{tables[0]}'").fetchone())

    rows = con.execute(
        "select * from bars where symbol=? and period=? order by ts desc limit ?",
        (symbol, period, limit),
    ).fetchall()
    cols = [d[0] for d in con.execute("select * from bars limit 1").description]
    print("columns:", cols, "rows:", len(rows))
    if not rows:
        # 退而求其次：看看库里有哪 些 symbol/period 组合
        print(con.execute("select symbol, period, count(*) from bars group by 1,2 limit 40").fetchall())
        return

    data = [dict(zip(cols, r)) for r in rows]
    data.reverse()
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print("wrote", out, len(data))


if __name__ == "__main__":
    main()
