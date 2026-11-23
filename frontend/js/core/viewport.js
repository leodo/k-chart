import { EventBus } from './event_bus.js';

/**
 * 视口模型：屏幕 x ↔ 数据索引，横向缩放/平移只改这里。
 *
 * 关键约定（修复"放大再缩小不回原位"）：
 * 1. _first 保存**未裁剪**的连续位置，firstIndex 是它的裁剪视图。
 *    缩放针对 _first 做运算，因此 factor 互为倒数时严格可逆，
 *    不受边界 clamp 影响。
 * 2. x ↔ index 映射包含绘图区左边距 left 和半根 K 线偏移，
 *    与 renderer.geometry() 完全一致，保证鼠标下的那根 K 线就是锚点。
 */
export class Viewport extends EventBus {
  constructor() {
    super();
    this.barWidth = 8;
    this.minBarWidth = 0.25;
    this.maxBarWidth = 60;
    this._first = 0;
    this.length = 0;
    this.rightOffset = 8;       // 右侧留白（"向前看"），单位=K线数
    this.left = 8;              // 绘图区左边距
    this.right = 76;            // 右侧价格轴宽度
    this.width = 0;
  }

  setLength(n) {
    this.length = Math.max(0, n | 0);
    this.emit('viewport', this);
  }

  setWidth(w) {
    this.width = Math.max(1, w);
    this.emit('viewport', this);
  }

  get plotWidth() { return Math.max(1, this.width - this.left - this.right); }
  get minFirst() { return -this.rightOffset; }
  get maxFirst() { return Math.max(this.minFirst, this.length - 2 + this.rightOffset); }

  /** 渲染使用的、带边界约束的位置。 */
  get firstIndex() {
    return Math.min(this.maxFirst, Math.max(this.minFirst, this._first));
  }
  /** 直接设置连续位置（内部使用）。 */
  setRawFirst(v) { this._first = v; }

  get visibleCount() { return Math.max(1, this.plotWidth / this.barWidth); }

  // 与 Renderer.geometry() 共用同一套映射
  xToIndex(x) { return this.firstIndex + (x - this.left) / this.barWidth - 0.5; }
  indexToX(i) { return this.left + (i - this.firstIndex + 0.5) * this.barWidth; }

  clamp() {
    this._first = Math.min(this.maxFirst, Math.max(this.minFirst, this._first));
  }

  /** 拖拽平移：dx>0 向左看历史。必须 clamp 未裁剪值，否则累积跑出边界形成死区。 */
  pan(dx) {
    if (!dx) return;
    const next = this._first - dx / this.barWidth;
    this._first = Math.min(this.maxFirst, Math.max(this.minFirst, next));
    this.emit('viewport', this);
  }

  /**
   * 以 anchorX 处的 K 线为锚做横向缩放。
   * factor>1 放大（K线变宽），factor<1 缩小。
   * 用 _first（未裁剪值）计算锚点，保证 zoom(f) 与 zoom(1/f) 严格互逆。
   */
  zoom(factor, anchorX) {
    const next = Math.min(this.maxBarWidth, Math.max(this.minBarWidth, this.barWidth * factor));
    if (next === this.barWidth) return;
    const offsetX = anchorX - this.left;
    const anchorRaw = this._first + offsetX / this.barWidth - 0.5;
    this.barWidth = next;
    this._first = anchorRaw + 0.5 - offsetX / next;
    this.emit('viewport', this);
  }

  fitAll(length) {
    if (length != null) this.length = Math.max(0, length | 0);
    if (!this.length || this.width <= 1) return;
    this.barWidth = Math.min(this.maxBarWidth,
      Math.max(this.minBarWidth, this.plotWidth / this.length));
    this._first = 0;
    this.emit('viewport', this);
  }

  fitToEnd(length) {
    if (length != null) this.length = Math.max(0, length | 0);
    this._first = this.length - this.visibleCount + this.rightOffset;
    this.emit('viewport', this);
  }

  /** 窄屏默认视图：按可见根数换算柱宽并定位最新，避免把上千根挤成一条线。 */
  fitRecent(count = 160) {
    if (!this.length || this.width <= 1) return;
    this.barWidth = Math.min(this.maxBarWidth,
      Math.max(this.minBarWidth, this.plotWidth / Math.max(10, count)));
    this.fitToEnd(this.length);
  }
}
