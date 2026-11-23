import { BaseTool } from './base_tool.js';

export class TrendLineTool extends BaseTool {
  constructor(manager) {
    super(manager);
    this.name = 'trendline';
    this.draft = null;
  }

  onDown(p) {
    this.draft = { i1: p.index, p1: p.price, i2: p.index, p2: p.price };
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
    this.manager.addShape(shape);
    this.manager.preview(null);
  }

  cancel() {
    this.draft = null;
    this.manager.preview(null);
  }
}
