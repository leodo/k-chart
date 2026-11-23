/** 绘图工具契约：数据坐标进出，渲染层无需知道具体工具。 */
export class BaseTool {
  constructor(manager) { this.manager = manager; this.name = 'base'; }
  onDown(_point) {}
  onMove(_point) {}
  onUp(_point) {}
  cancel() {}
}
