import { REGISTRY, defaultParams, defaultStyle, normalizeParams } from '../indicators/registry.js';

/**
 * TradingView 风格指标设置浮层：输入 / 样式双标签，按实例编辑，确定后回调应用。
 * 这里只负责表单与草稿状态，不触碰渲染细节；应用逻辑由调用方注入。
 */
export class IndicatorSettings {
  constructor({ onApply, onDelete }) {
    this.onApply = onApply;
    this.onDelete = onDelete;
    this.root = document.getElementById('indicator-settings');
    this.titleEl = document.getElementById('settings-title');
    this.body = document.getElementById('settings-body');
    this.tabInputs = document.getElementById('settings-tab-inputs');
    this.tabStyle = document.getElementById('settings-tab-style');
    this.ctx = null;
    this.tab = 'inputs';
    // 点浮层外的任意位置（图表、工具栏、其它菜单）都关闭浮层。
    // _armed 用来跳过「打开它的那一次 pointerdown」——否则刚点齿轮打开就会被同一次点击关掉。
    this._armed = false;
    document.addEventListener('pointerdown', e => {
      if (!this.isOpen || !this._armed) return;
      if (this.root.contains(e.target)) return;
      this.close();
    }, true);

    this.tabInputs.addEventListener('click', () => this.setTab('inputs'));
    this.tabStyle.addEventListener('click', () => this.setTab('style'));
    document.getElementById('settings-close').addEventListener('click', () => this.close());
    document.getElementById('settings-cancel').addEventListener('click', () => this.close());
    document.getElementById('settings-delete').addEventListener('click', () => {
      this.onDelete?.(this.ctx);
      this.close();
    });
    document.getElementById('settings-reset').addEventListener('click', () => this.reset());
    document.getElementById('settings-ok').addEventListener('click', () => this.apply());
    this.body.addEventListener('input', e => this.onField(e));
    this.body.addEventListener('change', e => this.onField(e));
  }

  get isOpen() { return !this.root.hidden; }

  open(ctx) {
    const meta = REGISTRY[ctx.indicator];
    if (!meta) return;
    this.ctx = ctx;
    this.meta = meta;
    this.draftParams = { ...(ctx.params || defaultParams(ctx.indicator)) };
    this.draftStyle = JSON.parse(JSON.stringify(ctx.style || defaultStyle(ctx.indicator)));
    this.titleEl.textContent = `${meta.name} 设置`;

    const r = document.getElementById('chart').getBoundingClientRect();
    this.root.hidden = false;                       // 先显示才能量到真实尺寸（窄屏宽度自适应）
    const w = this.root.offsetWidth, h = this.root.offsetHeight;
    this.root.style.left = `${Math.max(4, Math.min(ctx.x - r.left, r.width - w - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(ctx.y - r.top, r.height - h - 4))}px`;
    this.setTab('inputs');
    // 本轮 pointerdown 还在派发中（打开浮层的就是它），下一轮事件循环再允许"点外面关闭"。
    this._armed = false;
    setTimeout(() => { this._armed = true; }, 0);
  }

  close() {
    this.root.hidden = true;
    this.ctx = null;
    this._armed = false;
  }

  setTab(tab) {
    this.collectFields();
    this.tab = tab;
    this.tabInputs.classList.toggle('active', tab === 'inputs');
    this.tabStyle.classList.toggle('active', tab === 'style');
    this.renderBody();
  }

  /** 提交/切页时直接从 DOM 读值，兼容事件未触发（如自动填充、脚本赋值）的情况。 */
  collectFields() {
    if (!this.ctx) return;
    for (const el of this.body.querySelectorAll('[data-param]')) {
      this.draftParams[el.dataset.param] = el.value;
    }
    for (const el of this.body.querySelectorAll('[data-color]')) {
      this.draftStyle.lineColors[el.dataset.color] = el.value;
    }
    for (const el of this.body.querySelectorAll('[data-hist-up]')) {
      const c = this.draftStyle.histColors[el.dataset.histUp] || { up: '#f0515a', down: '#2eb87c' };
      c.up = el.value;
      this.draftStyle.histColors[el.dataset.histUp] = c;
    }
    for (const el of this.body.querySelectorAll('[data-hist-down]')) {
      const c = this.draftStyle.histColors[el.dataset.histDown] || { up: '#f0515a', down: '#2eb87c' };
      c.down = el.value;
      this.draftStyle.histColors[el.dataset.histDown] = c;
    }
    for (const el of this.body.querySelectorAll('[data-vis]')) {
      this.draftStyle.visible[el.dataset.vis] = el.checked;
    }
    for (const el of this.body.querySelectorAll('[data-style]')) {
      this.draftStyle[el.dataset.style] = el.value;
    }
  }

  renderBody() {
    if (!this.ctx) return;
    if (this.tab === 'inputs') this.renderInputs();
    else this.renderStyle();
  }

  renderInputs() {
    const rows = this.meta.params.map(p => {
      const tip = p.tip || p.label;
      if (Array.isArray(p.options) && p.options.length) {
        const cur = String(this.draftParams[p.key] ?? p.def);
        const opts = p.options.map(([v, label]) =>
          `<option value="${v}"${String(v) === cur ? ' selected' : ''}>${label}</option>`).join('');
        return `<label class="setting-row" title="${tip}"><span>${p.label}</span><select data-param="${p.key}">${opts}</select></label>`;
      }
      return `<label class="setting-row" title="${tip}">
        <span>${p.label}</span>
        <input type="number" data-param="${p.key}" min="${p.min}" max="${p.max}" step="${p.step || 1}"
          value="${this.draftParams[p.key] ?? p.def}">
      </label>`;
    }).join('');
    this.body.innerHTML = rows
      || '<div class="setting-empty">该指标无可调输入参数，可在「样式」中调整显示。</div>';
  }

  renderStyle() {
    const params = normalizeParams(this.ctx.indicator, this.draftParams);
    const lines = this.meta.lines(params);
    let html = '<div class="settings-sub">线条</div>';

    for (const line of lines) {
      const checked = this.draftStyle.visible?.[line.key] !== false;
      html += `<div class="style-row">
        <input type="checkbox" data-vis="${line.key}" ${checked ? 'checked' : ''} title="显示">
        <span class="style-name">${line.label}</span>`;
      if (line.type === 'hist') {
        const c = this.draftStyle.histColors?.[line.key] || { up: '#f0515a', down: '#2eb87c' };
        html += `<input type="color" data-hist-up="${line.key}" value="${c.up}" title="上涨颜色">
                 <input type="color" data-hist-down="${line.key}" value="${c.down}" title="下跌颜色">`;
      } else {
        const c = this.draftStyle.lineColors?.[line.key] || line.color;
        html += `<input type="color" data-color="${line.key}" value="${c}" title="线条颜色">`;
      }
      html += '</div>';
    }

    const opts = [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']]
      .map(([v, label]) => `<option value="${v}"${this.draftStyle.lineStyle === v ? ' selected' : ''}>${label}</option>`)
      .join('');
    html += `<div class="settings-sub">通用</div>
      <label class="setting-row"><span>线宽</span>
        <input type="number" data-style="lineWidth" min="0.4" max="6" step="0.1" value="${this.draftStyle.lineWidth}">
      </label>
      <label class="setting-row"><span>线型</span>
        <select data-style="lineStyle">${opts}</select>
      </label>`;
    this.body.innerHTML = html;
  }

  onField(e) {
    const t = e.target;
    if (t.dataset.param) this.draftParams[t.dataset.param] = t.value;
    else if (t.dataset.color) this.draftStyle.lineColors[t.dataset.color] = t.value;
    else if (t.dataset.histUp) {
      const c = this.draftStyle.histColors[t.dataset.histUp] || { up: '#f0515a', down: '#2eb87c' };
      c.up = t.value;
      this.draftStyle.histColors[t.dataset.histUp] = c;
    } else if (t.dataset.histDown) {
      const c = this.draftStyle.histColors[t.dataset.histDown] || { up: '#f0515a', down: '#2eb87c' };
      c.down = t.value;
      this.draftStyle.histColors[t.dataset.histDown] = c;
    } else if (t.dataset.vis) this.draftStyle.visible[t.dataset.vis] = t.checked;
    else if (t.dataset.style) this.draftStyle[t.dataset.style] = t.value;
  }

  reset() {
    this.draftParams = defaultParams(this.ctx.indicator);
    this.draftStyle = defaultStyle(this.ctx.indicator);
    this.renderBody();
  }

  apply() {
    if (!this.ctx) return;
    this.collectFields();
    const { kind, id, indicator } = this.ctx;
    const params = normalizeParams(indicator, this.draftParams);
    const width = Number(this.draftStyle.lineWidth);
    const style = {
      ...this.draftStyle,
      lineWidth: Number.isFinite(width) ? Math.max(0.4, Math.min(6, width)) : 1.2,
    };
    this.onApply?.({ kind, id, params, style });
    this.close();
  }
}
