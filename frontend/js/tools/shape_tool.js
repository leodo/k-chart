import { BaseTool } from './base_tool.js';

/** 通用两点图形工具：趋势线、射线、水平线、垂直线、矩形、斐波那契、测量、文字。 */
export class ShapeTool extends BaseTool {
  constructor(manager, type) {
    super(manager);
    this.name = type;
    this.type = type;
    this.draft = null;
  }

  onDown(p) {
    this.draft = {
      type: this.type, i1: p.index, p1: p.price, i2: p.index, p2: p.price,
      color: this.manager.defaultColor, width: 1.5,
    };
    this.manager.preview(this.draft);
  }

  onMove(p) {
    if (!this.draft) return;
    this.draft.i2 = p.index;
    this.draft.p2 = p.price;
    this.manager.preview(this.draft);
  }

  onUp(p) {
    if (!this.draft) return;
    this.draft.i2 = p.index;
    this.draft.p2 = p.price;
    const shape = this.draft;
    this.draft = null;
    if (shape.type === 'text') {
      const text = window.prompt('输入文字', '文本');
      if (text == null) { this.manager.preview(null); return; }
      shape.text = text;
      shape.i2 = shape.i1;
      shape.p2 = shape.p1;
    }
    if (shape.type === 'horizontal') {
      shape.i2 = shape.i1;
      shape.p2 = shape.p1;
    }
    this.manager.addShape(shape);
    this.manager.preview(null);
  }

  cancel() {
    this.draft = null;
    this.manager.preview(null);
  }
}
