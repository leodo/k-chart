import { ShapeTool } from './shape_tool.js';

export const DRAW_TOOLS = ['select', 'trendline', 'ray', 'horizontal', 'vertical', 'rect', 'fib', 'measure', 'text'];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** 工具注册处：图形统一为数据坐标两点模型，选择工具负责命中/移动/删除。 */
export class ToolManager {
  constructor(renderer) {
    this.renderer = renderer;
    this.shapes = [];
    this.draft = null;
    this.registry = { select: null };
    for (const type of DRAW_TOOLS) {
      if (type !== 'select') this.registry[type] = new ShapeTool(this, type);
    }
    // 默认就是选择模式：打开页面即可点选已画好的线，无需先去菜单里切换。
    this.active = { name: 'select', cancel() {} };
    this.selected = null;
    this.drag = null;
    this.history = [];
    this.defaultColor = '#f2c14e';
    this.onSelectionChange = null;
    this.onChange = null;
  }

  setActive(name) {
    this.active?.cancel?.();
    this.active = name === 'select'
      ? { name: 'select', cancel() {} }
      : (this.registry[name] || null);
    if (name !== 'select') this.select(null);
    return !!this.active;
  }

  get isDrawing() { return !!this.active && this.active.name !== 'select'; }

  preview(shape) { this.draft = shape; this.sync(); }

  addShape(shape) {
    this.history.push(this.shapes.slice());
    if (this.history.length > 50) this.history.shift();
    this.shapes.push(shape);
    this.sync();
  }

  sync() {
    this.renderer.setShapes(this.draft ? [...this.shapes, this.draft] : this.shapes);
    this.onChange?.();
  }

  select(shape) {
    this.selected = shape || null;
    this.renderer.setSelected(this.selected);
    this.onSelectionChange?.(this.selected);
  }

  load(shapes) {
    this.shapes = Array.isArray(shapes) ? shapes.slice() : [];
    this.draft = null;
    this.history = [];
    this.select(null);
    this.sync();
  }

  clear() { this.load([]); }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.shapes = prev;
    this.select(null);
    this.sync();
    return true;
  }

  pointerDown(point) { this.active?.onDown?.(point); }
  pointerMove(point) { this.active?.onMove?.(point); }
  pointerUp(point) {
    const before = this.shapes.length;
    const wasDrawing = this.isDrawing;
    this.active?.onUp?.(point);
    if (wasDrawing && this.shapes.length > before) {
      // 画完即切回选择模式并选中刚画的图形：马上能拖动端点、改颜色、删除。
      const added = this.shapes[this.shapes.length - 1];
      this.setActive('select');
      this.select(added);
    } else if (this.isDrawing) {
      this.setActive(this.active.name);
    }
  }
  cancel() { this.active?.cancel?.(); }

  /** 屏幕命中测试：端点优先，其次线/框/文字/斐波那契水平线。pad 用于触摸放大命中区。 */
  hitTest(p, renderer, pad = 0) {
    const g = renderer._geometry || renderer.geometry();
    const X = i => g.indexToX(i);
    const Y = v => g.main.priceToY(v);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const segDist = (pt, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (!l2) return dist(pt, a);
      let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      return dist(pt, { x: a.x + t * dx, y: a.y + t * dy });
    };

    for (let k = this.shapes.length - 1; k >= 0; k--) {
      const s = this.shapes[k];
      const a = { x: X(s.i1), y: Y(s.p1) }, b = { x: X(s.i2), y: Y(s.p2) };
      if (dist(p, a) <= 7 + pad) return { shape: s, part: 'p1' };
      if (!['horizontal', 'vertical', 'text'].includes(s.type) && dist(p, b) <= 7 + pad) return { shape: s, part: 'p2' };
      if (s.type === 'horizontal' && Math.abs(p.y - a.y) <= 4 + pad) return { shape: s, part: 'body' };
      if (s.type === 'vertical' && Math.abs(p.x - a.x) <= 4 + pad) return { shape: s, part: 'body' };
      if (s.type === 'text' && Math.abs(p.x - a.x) < 80 + pad && Math.abs(p.y - a.y + 9) < 12 + pad) {
        return { shape: s, part: 'body' };
      }
      if (s.type === 'rect' && p.x >= Math.min(a.x, b.x) - 3 - pad && p.x <= Math.max(a.x, b.x) + 3 + pad
        && p.y >= Math.min(a.y, b.y) - 3 - pad && p.y <= Math.max(a.y, b.y) + 3 + pad) {
        return { shape: s, part: 'body' };
      }
      if (s.type === 'fib') {
        for (const lv of FIB_LEVELS) {
          const y = Y(s.p1 + (s.p2 - s.p1) * lv);
          if (p.x >= Math.min(a.x, b.x) - 3 - pad && p.x <= Math.max(a.x, b.x) + 60 + pad && Math.abs(p.y - y) <= 3 + pad) {
            return { shape: s, part: 'body' };
          }
        }
      }
      if (segDist(p, a, b) <= 4 + pad) return { shape: s, part: 'body' };
    }
    return null;
  }

  selectDown(p, renderer, pad = 0) {
    const hit = this.hitTest(p, renderer, pad);
    if (!hit) { this.select(null); return false; }
    this.select(hit.shape);
    this.drag = { part: hit.part, shape: hit.shape, last: renderer.screenToMainData(p.x, p.y) };
    return true;
  }

  selectMove(p, renderer) {
    if (!this.drag) return;
    const d = renderer.screenToMainData(p.x, p.y);
    const di = d.index - this.drag.last.index;
    const dp = d.price - this.drag.last.price;
    const s = this.drag.shape;
    if (this.drag.part === 'p1') { s.i1 += di; s.p1 += dp; }
    else if (this.drag.part === 'p2') { s.i2 += di; s.p2 += dp; }
    else { s.i1 += di; s.i2 += di; s.p1 += dp; s.p2 += dp; }
    this.drag.last = d;
    this.sync();
  }

  selectUp() { this.drag = null; }

  deleteSelected() {
    if (!this.selected) return false;
    this.history.push(this.shapes.slice());
    this.shapes = this.shapes.filter(s => s !== this.selected);
    this.select(null);
    this.sync();
    return true;
  }

  updateSelected(patch) {
    if (!this.selected) return;
    Object.assign(this.selected, patch);
    this.sync();
  }
}
