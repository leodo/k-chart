/**
 * 交互控制器：把鼠标/触摸输入翻译成视口、面板比例、工具事件。
 *
 * 桌面命中优先级：面板标题 > 分隔线 > 价格轴 > 图例按钮 > 绘图区。
 * 桌面分区行为：
 *  - 滚轮：绘图区横向缩放（光标锚点）；Shift+滚轮横向平移；Ctrl+滚轮双向缩放；价格轴纵向缩放。
 *  - 价格轴拖拽纵向平移，双击复位比例；分隔线拖拽调整相邻面板。
 *
 * 触摸行为（手机）：
 *  - 单指拖动：横向平移；落在价格轴上则纵向平移；在绘图区纵向拖动也会平移价格。
 *  - 双指捏合：横向捏合缩放时间轴（以双指中点为锚），纵向捏合缩放价格轴；
 *    双指同向移动则平移（时间 + 价格）。
 *  - 单击：显示十字光标并可作为 UI 按钮点击（齿轮/步进器/标题带更大命中区）。
 *  - 双击：绘图区回到最新 K 线；价格轴复位纵向比例。
 *  - 长按：保持十字光标，方便读取数值；不触发浏览器上下文菜单。
 */
export class InteractionController {
  constructor(canvas, viewport, renderer, panes, tools, getLength, onPaneMenu, onIndicatorSettings, onSupportStep, onEyeToggle, onPaneSwitch) {
    this.canvas = canvas;
    this.vp = viewport;
    this.renderer = renderer;
    this.panes = panes;
    this.tools = tools;
    this.getLength = getLength;
    this.onPaneMenu = onPaneMenu;
    this.onIndicatorSettings = onIndicatorSettings;
    this.onSupportStep = onSupportStep;
    this.onEyeToggle = onEyeToggle;
    this.onPaneSwitch = onPaneSwitch;
    this.dragging = false;
    this.axisDragging = null;
    this.resizing = null;
    this.drawingActive = false;
    this.lastX = 0;
    this.lastY = 0;
    this.dragPaneId = null;

    // 触摸状态
    this.pointers = new Map();       // pointerId -> {x,y}
    this.pinch = null;               // {distX, distY, midX, midY}
    this.touchAction = null;         // 待到 up 才执行的 UI 点击
    this.touchStart = null;          // {x,y,t,paneId}
    this.lastTap = null;             // {x,y,t}
    this.touchMode = false;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('pointerleave', e => {
      if (e.pointerType === 'touch') return;   // 手指抬起后保留十字光标
      this.renderer.setCrosshair(null);
      this.canvas.style.cursor = 'crosshair';
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => this.onDblClick(e));
    window.addEventListener('keydown', e => this.onKey(e));
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** 触摸时放大所有命中区，补偿手指精度。 */
  get pad() { return this.touchMode ? 9 : 0; }

  inBox(p, b, pad = 0) {
    return !!b && p.x >= b.x - pad && p.x <= b.x + b.w + pad
      && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
  }

  isAxis(p) {
    return p.x >= this.vp.width - this.vp.right - this.pad && p.y < this.renderer.height - 22;
  }

  hitPaneTitle(p) {
    const g = this.renderer.geometry();
    for (const pane of g.panes) {
      if (pane.kind !== 'indicator') continue;
      const tr = pane.titleRect;
      if (p.x >= tr.x - 2 - this.pad && p.x <= tr.x + tr.w + this.pad
        && p.y >= tr.y - 2 - this.pad && p.y <= tr.y + tr.h + this.pad) return pane;
    }
    return null;
  }

  /** 图例齿轮：使用最近一次渲染产出的命中区，避免重复 geometry 计算。 */
  hitSetting(p) {
    const icons = this.renderer._geometry?.settingsIcons || [];
    return icons.find(ic => this.inBox(p, ic, this.pad)) || null;
  }

  /** 支撑线图例的 +/− 命中区。 */
  hitStepper(p) {
    const icons = this.renderer._geometry?.stepperIcons || [];
    return icons.find(ic => this.inBox(p, ic, this.pad)) || null;
  }

  /** 图例主图指标的小眼睛。 */
  hitEye(p) {
    const icons = this.renderer._geometry?.eyeIcons || [];
    return icons.find(ic => this.inBox(p, ic, this.pad)) || null;
  }

  /** 副图标题的指标切换按钮。 */
  hitSwitch(p) {
    const icons = this.renderer._geometry?.switchIcons || [];
    return icons.find(ic => this.inBox(p, ic, this.pad)) || null;
  }

  hitSeparator(p) {
    const g = this.renderer.geometry();
    const tol = 4 + this.pad;
    for (let i = 0; i < g.panes.length - 1; i++) {
      const pane = g.panes[i];
      if (pane.separatorY == null) continue;
      if (Math.abs(p.y - pane.separatorY) <= tol && p.x >= g.left && p.x <= g.width - g.right) {
        return { upper: pane, lower: g.panes[i + 1] };
      }
    }
    return null;
  }

  normalizedDelta(e) {
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= this.renderer.height;
    return dy;
  }

  /* ---------------- 指针按下 ---------------- */
  onDown(e) {
    const p = this.local(e);
    this.touchMode = e.pointerType === 'touch';
    this.canvas.setPointerCapture?.(e.pointerId);
    if (this.touchMode) this.pointers.set(e.pointerId, p);

    // 双指：取消单指/绘图状态，进入捏合
    if (this.touchMode && this.pointers.size === 2) {
      this.touchAction = null;
      this.dragging = false;
      this.axisDragging = null;
      this.resizing = null;
      this.drawingActive = false;
      this.tools.selectUp();
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        distX: Math.max(1, Math.abs(b.x - a.x)),
        distY: Math.max(1, Math.abs(b.y - a.y)),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      this.renderer.setCrosshair(null);
      return;
    }
    if (this.touchMode && this.pointers.size > 2) return;

    this.renderer.setCrosshair(p);

    // UI 命中：鼠标立即执行；触摸等 up 时确认不是拖动再执行
    const eye = this.hitEye(p);
    if (eye) {
      const run = () => { this.onPaneMenu?.(null); this.onEyeToggle?.(eye); };
      if (this.touchMode) this.touchAction = run; else run();
      return;
    }
    const switcher = this.hitSwitch(p);
    if (switcher) {
      const run = () => this.onPaneSwitch?.(switcher, e.clientX, e.clientY);
      if (this.touchMode) this.touchAction = run; else run();
      return;
    }
    const setting = this.hitSetting(p);
    if (setting) {
      if (this.touchMode) this.touchAction = () => {
        this.onPaneMenu?.(null);
        this.onIndicatorSettings?.(setting, e.clientX, e.clientY);
      };
      else {
        this.onPaneMenu?.(null);
        this.onIndicatorSettings?.(setting, e.clientX, e.clientY);
      }
      return;
    }
    const stepper = this.hitStepper(p);
    if (stepper) {
      if (this.touchMode) this.touchAction = () => {
        this.onPaneMenu?.(null);
        this.onSupportStep?.(stepper.id, stepper.action);
      };
      else {
        this.onPaneMenu?.(null);
        this.onSupportStep?.(stepper.id, stepper.action);
      }
      return;
    }
    const title = this.hitPaneTitle(p);
    if (title) {
      if (this.touchMode) this.touchAction = () => this.onPaneMenu?.(title.id, e.clientX, e.clientY);
      else this.onPaneMenu?.(title.id, e.clientX, e.clientY);
      return;
    }
    this.onPaneMenu?.(null);   // 点非标题区域：关闭已打开的菜单

    const sep = this.hitSeparator(p);
    if (sep) {
      if (this.touchMode) this.touchAction = () => {
        this.resizing = null;
        this.panes.resizePair(sep.upper.id, sep.lower.id, 0, sep.upper.height, sep.lower.height);
      };
      else {
        this.resizing = {
          id1: sep.upper.id, id2: sep.lower.id,
          startY: p.y, h1: sep.upper.height, h2: sep.lower.height,
        };
        this.canvas.style.cursor = 'ns-resize';
      }
      return;
    }

    if (this.isAxis(p)) {
      this.axisDragging = { id: this.renderer.paneAtY(p.y).id, y: p.y };
      this.canvas.style.cursor = 'ns-resize';
    } else if (this.tools.active?.name === 'select') {
      if (!this.tools.selectDown(p, this.renderer, this.pad)) {
        this.dragging = true;
        this.lastX = p.x; this.lastY = p.y;
        this.dragPaneId = this.renderer.paneAtY(p.y).id;
        this.canvas.style.cursor = 'grabbing';
      }
    } else if (this.tools.isDrawing) {
      this.drawingActive = true;
      this.tools.pointerDown(this.renderer.screenToMainData(p.x, p.y));
    } else {
      this.dragging = true;
      this.lastX = p.x; this.lastY = p.y;
      this.dragPaneId = this.renderer.paneAtY(p.y).id;
      this.canvas.style.cursor = 'grabbing';
    }
    if (this.touchMode) {
      this.touchStart = { x: p.x, y: p.y, t: performance.now(), paneId: this.dragPaneId };
    }
  }

  /* ---------------- 指针移动 ---------------- */
  onMove(e) {
    const p = this.local(e);
    this.touchMode = e.pointerType === 'touch';
    if (this.touchMode && this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);

    // 双指捏合 / 平移
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distX = Math.max(1, Math.abs(b.x - a.x));
      const distY = Math.max(1, Math.abs(b.y - a.y));
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const fx = Math.min(2, Math.max(0.5, distX / this.pinch.distX));
      const fy = Math.min(2, Math.max(0.5, distY / this.pinch.distY));
      // 以捏合前的中点为锚缩放，再把中点位移转成平移，保证跟手
      if (Math.abs(fx - 1) > 1e-4) this.vp.zoom(fx, this.pinch.midX);
      if (Math.abs(fy - 1) > 1e-4) {
        this.renderer.verticalZoom(this.renderer.paneAtY(this.pinch.midY).id, fy, this.pinch.midY);
      }
      const dx = midX - this.pinch.midX;
      if (dx) this.vp.pan(dx);
      const dy = midY - this.pinch.midY;
      if (dy) this.renderer.verticalPan(this.renderer.paneAtY(midY).id, dy);
      this.pinch = { distX, distY, midX, midY };
      return;
    }

    this.renderer.setCrosshair(p);
    this.renderer.setHoverSetting(this.hitSetting(p));
    this.renderer.setHoverStepper(this.hitStepper(p));
    this.renderer.setHoverEye(this.hitEye(p));
    this.renderer.setHoverSwitch(this.hitSwitch(p));

    // 单指按下后移动超过阈值：取消待执行的 UI 点击，确认是拖动
    if (this.touchMode && this.touchStart && this.touchAction) {
      const moved = Math.hypot(p.x - this.touchStart.x, p.y - this.touchStart.y);
      if (moved > 10) this.touchAction = null;
    }

    if (this.resizing) {
      this.panes.resizePair(
        this.resizing.id1, this.resizing.id2,
        p.y - this.resizing.startY, this.resizing.h1, this.resizing.h2
      );
    } else if (this.axisDragging) {
      this.renderer.verticalPan(this.axisDragging.id, p.y - this.axisDragging.y);
      this.axisDragging.y = p.y;
    } else if (this.tools.drag) {
      this.tools.selectMove(p, this.renderer);
    } else if (this.drawingActive) {
      this.tools.pointerMove(this.renderer.screenToMainData(p.x, p.y));
    } else if (this.dragging) {
      this.vp.pan(p.x - this.lastX);
      if (this.touchMode && this.dragPaneId) {
        this.renderer.verticalPan(this.dragPaneId, p.y - this.lastY);
      }
      this.lastX = p.x; this.lastY = p.y;
    } else {
      const overShape = this.tools.active?.name === 'select' && this.tools.hitTest(p, this.renderer, this.pad);
      const cursor = this.hitSetting(p) || this.hitStepper(p) || this.hitEye(p) || this.hitSwitch(p) || overShape ? 'pointer'
        : (this.isAxis(p) || this.hitSeparator(p)) ? 'ns-resize'
          : (this.hitPaneTitle(p) ? 'pointer' : 'crosshair');
      this.canvas.style.cursor = cursor;
    }
  }

  /* ---------------- 指针抬起 ---------------- */
  onUp(e) {
    const p = this.local(e);
    this.touchMode = e.pointerType === 'touch';
    if (this.touchMode) this.pointers.delete(e.pointerId);

    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.dragging = false;
        this.axisDragging = null;
        // 剩余一根手指继续拖动时重置基准，避免跳变
        const rest = [...this.pointers.values()][0];
        if (rest) { this.lastX = rest.x; this.lastY = rest.y; this.touchStart = null; }
      }
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    // 触摸：未移动则执行待定的 UI 点击，并识别双击
    if (this.touchMode) {
      const ts = this.touchStart;
      const moved = ts ? Math.hypot(p.x - ts.x, p.y - ts.y) : 999;
      if (moved <= 10 && (!ts || performance.now() - ts.t < 800)) {
        this.touchAction?.();
        const now = performance.now();
        const prev = this.lastTap;
        if (prev && now - prev.t < 330 && Math.hypot(p.x - prev.x, p.y - prev.y) < 32) {
          this.onDblClick({ ...p, __touch: true });
          this.lastTap = null;
        } else {
          this.lastTap = { x: p.x, y: p.y, t: now };
        }
      } else {
        this.lastTap = null;
      }
      this.touchAction = null;
      this.touchStart = null;
    }

    this.tools.selectUp();
    if (this.drawingActive) {
      this.tools.pointerUp(this.renderer.screenToMainData(p.x, p.y));
      this.drawingActive = false;
    }
    this.dragging = false;
    this.axisDragging = null;
    this.resizing = null;
    this.canvas.style.cursor = this.isAxis(p) ? 'ns-resize' : 'crosshair';
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.local(e);
    const dy = this.normalizedDelta(e);
    if (!dy && !e.deltaX) return;
    const factor = Math.exp(-dy * 0.0015);

    if (this.isAxis(p)) {
      this.renderer.verticalZoom(this.renderer.paneAtY(p.y).id, factor, p.y);
      return;
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.vp.pan(-e.deltaX * 0.6);
      return;
    }
    if (e.shiftKey) {
      this.vp.pan(dy * 0.8);
      return;
    }
    this.vp.zoom(factor, p.x);
    if (e.ctrlKey || e.metaKey) {
      this.renderer.verticalZoom(this.renderer.paneAtY(p.y).id, factor, p.y);
    }
  }

  onDblClick(e) {
    // 触摸双击已在 onUp 中处理，避免浏览器合成事件重复触发
    if (e.__touch) {
      if (this.isAxis(e)) this.renderer.resetScale(this.renderer.paneAtY(e.y).id);
      else if (this.tools.active?.name === 'select' && this.tools.hitTest(e, this.renderer, this.pad)) {
        // 图形上的双击不触发"回到最新"，以免和选中/编辑冲突。
      } else if (!this.hitPaneTitle(e) && !this.hitSeparator(e)) this.vp.fitToEnd(this.getLength());
      return;
    }
    const p = this.local(e);
    if (this.tools.active?.name === 'select' && this.tools.hitTest(p, this.renderer)) return;
    if (this.isAxis(p)) this.renderer.resetScale(this.renderer.paneAtY(p.y).id);
    else if (!this.hitPaneTitle(p) && !this.hitSeparator(p)) this.vp.fitToEnd(this.getLength());
  }

  onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Escape') { this.tools.cancel(); this.tools.select(null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.tools.deleteSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { this.tools.undo(); return; }
    if (e.key === 'End') { this.vp.fitToEnd(this.getLength()); return; }
    if (e.key === 'ArrowLeft') this.vp.pan(80);
    if (e.key === 'ArrowRight') this.vp.pan(-80);
    if (e.key === '+' || e.key === '=') this.vp.zoom(1.25, this.vp.left + this.vp.plotWidth / 2);
    if (e.key === '-') this.vp.zoom(0.8, this.vp.left + this.vp.plotWidth / 2);
  }
}
