import { EventBus } from './event_bus.js';

/** 只持有当前图表数据；不关心数据从哪来、怎么画。 */
export class BarStore extends EventBus {
  constructor() {
    super();
    this.bars = [];
    this.symbol = '';
    this.period = '5m';
    this.digits = null; // 价格小数位：伦敦金/银=2，国内期货=null（按量级推断）
    this.version = 0;   // 数据指纹：指标缓存据此失效
  }

  setBars(bars, meta = {}) {
    this.bars = bars.slice().sort((a, b) => a.ts - b.ts);
    if (meta.symbol) this.symbol = meta.symbol;
    if (meta.period) this.period = meta.period;
    if (meta.digits !== undefined) this.digits = Number.isFinite(meta.digits) ? meta.digits : null;
    this.version++;
    this.emit('data', { reason: 'reset' });
  }

  mergeBars(bars) {
    for (const bar of bars || []) this.upsert(bar);
  }

  upsert(bar) {
    if (!bar) return;
    const last = this.bars[this.bars.length - 1];
    if (last && last.ts === bar.ts) {
      // 同一根 K 线、价格和量都没变（收盘后轮询到的旧快照）：不触发重算与重绘。
      if (last.open === bar.open && last.high === bar.high && last.low === bar.low
        && last.close === bar.close && last.volume === bar.volume && last.oi === bar.oi) return;
      this.bars[this.bars.length - 1] = bar;
      this.version++;
      this.emit('data', { reason: 'update' });
      return;
    }
    if (last && bar.ts < last.ts) {
      const idx = this.bars.findIndex(b => b.ts === bar.ts);
      if (idx >= 0) {
        this.bars[idx] = bar;
        this.version++;
        this.emit('data', { reason: 'update' });
      }
      return;
    }
    this.bars.push(bar);
    if (this.bars.length > 12000) this.bars.splice(0, this.bars.length - 12000);
    this.version++;
    this.emit('data', { reason: 'append' });
  }

  get length() { return this.bars.length; }
  at(i) { return this.bars[i]; }
}
