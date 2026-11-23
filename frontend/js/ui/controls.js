import { PANE_OPTIONS, REGISTRY } from '../indicators/registry.js';

const PERIODS = [
  ['1m', '1分'], ['5m', '5分'], ['15m', '15分'],
  ['30m', '30分'], ['1h', '1时'], ['4h', '4时'], ['1d', '日线'], ['1w', '周线'],
];

/** 顶部工具栏：只负责把控件事件转给上层，不持有业务状态。 */
export class Controls {
  constructor(handlers) {
    this.h = handlers;
    this.symbolEl = document.getElementById('symbol');
    this.symbolPicker = document.getElementById('symbol-picker');
    this.symbolButton = document.getElementById('symbol-button');
    this.symbolLabel = document.getElementById('symbol-label');
    this.symbolDropdown = document.getElementById('symbol-dropdown');
    this.symbolSearch = document.getElementById('symbol-search');
    this.symbolList = document.getElementById('symbol-list');
    this.symbols = [];
    this.filtered = [];
    this.activeIndex = 0;
    this.periodEl = document.getElementById('periods');
    this.statusEl = document.getElementById('status');
    this.quoteEl = document.getElementById('quote');
    this.latestBtn = document.getElementById('latest');
    this.fitAllBtn = document.getElementById('fitall');
    this.indicatorEl = document.getElementById('indicator');
    this.addPaneBtn = document.getElementById('addpane');
    this.delPaneBtn = document.getElementById('delpane');

    // 窄屏：次要控件收进「更多」抽屉；点击图表区域自动收起。
    this.toolbar = document.getElementById('toolbar');
    this.moreBtn = document.getElementById('toolbar-more');
    this.moreBtn?.addEventListener('click', e => {
      e.stopPropagation();
      this.toolbar.classList.toggle('open');
      this.moreBtn.textContent = this.toolbar.classList.contains('open') ? '✕' : '☰';
    });
    document.addEventListener('pointerdown', e => {
      if (this.toolbar.classList.contains('open') && !this.toolbar.contains(e.target)) {
        this.toolbar.classList.remove('open');
        if (this.moreBtn) this.moreBtn.textContent = '☰';
      }
    });

    this.symbolEl.addEventListener('change', () => {
      this.updateSymbolLabel();
      this.h.onSymbol(this.symbolEl.value);
    });
    this.symbolButton.addEventListener('click', e => {
      e.stopPropagation();
      if (!this.symbolDropdown.hidden) { this.closeSymbolDropdown(); return; }
      this.openSymbolDropdown();
    });
    this.symbolSearch.addEventListener('input', () => this.renderSymbolList());
    this.symbolSearch.addEventListener('keydown', e => this.onSymbolKey(e));
    this.symbolSearch.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('pointerdown', e => {
      if (!this.symbolDropdown.hidden && !this.symbolPicker.contains(e.target)) this.closeSymbolDropdown();
    });
    this.latestBtn.addEventListener('click', () => this.h.onLatest());
    this.fitAllBtn.addEventListener('click', () => this.h.onFitAll());

    for (const id of PANE_OPTIONS) this.indicatorEl.appendChild(new Option(REGISTRY[id].short, id));
    this.indicatorEl.value = 'volume';
    this.addPaneBtn.addEventListener('click', () => this.h.onAddPane(this.indicatorEl.value));
    this.delPaneBtn.addEventListener('click', () => this.h.onDelPane());
    this.setPaneCount(1);

    for (const [value, label] of PERIODS) {
      const btn = document.createElement('button');
      btn.dataset.period = value;
      btn.textContent = label;
      btn.addEventListener('click', () => { this.setPeriod(value); this.h.onPeriod(value); });
      this.periodEl.appendChild(btn);
    }
  }

  populateSymbols(symbols, selected) {
    this.symbols = symbols || [];
    const groups = new Map();
    for (const s of this.symbols) {
      if (!groups.has(s.exchange)) groups.set(s.exchange, document.createElement('optgroup'));
      groups.get(s.exchange).appendChild(new Option(`${s.name} (${s.code})`, s.code));
    }
    this.symbolEl.replaceChildren(...[...groups.entries()].map(([ex, el]) => {
      el.label = ex;
      return el;
    }));
    if (selected) this.symbolEl.value = selected;
    this.updateSymbolLabel();
  }

  updateSymbolLabel() {
    const s = this.symbols.find(x => x.code === this.symbolEl.value);
    this.symbolLabel.textContent = s ? `${s.name} (${s.code})` : (this.symbolEl.value || '选择品种');
  }

  /** 供布局恢复使用：只更新显示，不触发 onSymbol（避免重复重载）。 */
  setSymbol(value) {
    this.symbolEl.value = value;
    this.updateSymbolLabel();
  }

  openSymbolDropdown() {
    this.symbolDropdown.hidden = false;
    this.symbolSearch.value = '';
    this.renderSymbolList();
    this.symbolSearch.focus();
    this.symbolSearch.select();
  }

  closeSymbolDropdown() { this.symbolDropdown.hidden = true; }

  renderSymbolList() {
    const q = this.symbolSearch.value.trim().toLowerCase();
    this.filtered = this.symbols.filter(s =>
      !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));
    this.activeIndex = Math.min(this.activeIndex, Math.max(0, this.filtered.length - 1));
    this.symbolList.replaceChildren(...this.filtered.map((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `symbol-option${i === this.activeIndex ? ' selected' : ''}${s.code === this.symbolEl.value ? ' current' : ''}`;
      btn.textContent = `${s.name} (${s.code})`;
      btn.addEventListener('click', e => { e.stopPropagation(); this.chooseSymbol(s.code); });
      return btn;
    }));
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'symbol-empty';
      empty.textContent = '没有匹配的品种';
      this.symbolList.appendChild(empty);
    }
  }

  onSymbolKey(e) {
    if (e.key === 'Escape') { this.closeSymbolDropdown(); this.symbolButton.focus(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.filtered[this.activeIndex]) this.chooseSymbol(this.filtered[this.activeIndex].code);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.filtered.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex = (this.activeIndex + delta + this.filtered.length) % this.filtered.length;
      this.renderSymbolList();
      this.symbolList.children[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }

  chooseSymbol(code) {
    this.closeSymbolDropdown();
    this.symbolButton.focus();
    if (code === this.symbolEl.value) return;
    this.symbolEl.value = code;
    this.updateSymbolLabel();
    this.h.onSymbol(code);
  }

  setPeriod(value) {
    for (const btn of this.periodEl.children) btn.classList.toggle('active', btn.dataset.period === value);
  }

  setPaneCount(n) {
    this.delPaneBtn.disabled = n <= 1;
    this.addPaneBtn.disabled = n >= 4;
  }

  setStatus(text, isError = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', !!isError);
  }

  setQuote(quote) {
    if (!quote) { this.quoteEl.textContent = ''; return; }
    const diff = quote.price - quote.pre_close;
    const pct = quote.pre_close ? (diff / quote.pre_close) * 100 : 0;
    const cls = diff >= 0 ? '#f0515a' : '#2eb87c';
    this.quoteEl.innerHTML = `<b style="color:${cls}">${quote.price.toFixed(2)}</b> ${diff >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  }
}
