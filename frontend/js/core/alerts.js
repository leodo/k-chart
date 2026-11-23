/** 价格警报：上破/下破阈值，触发后只通知一次，支持持久化。 */
export class AlertManager {
  constructor(onFire) {
    this.items = [];
    this.onFire = onFire;
    this.seq = 1;
  }

  add({ symbol, dir, price }) {
    const p = Number(price);
    if (!symbol || !Number.isFinite(p) || p <= 0) return null;
    const item = { id: this.seq++, symbol: symbol.toUpperCase(), dir, price: p, enabled: true, triggered: false };
    this.items.push(item);
    return item;
  }

  remove(id) { this.items = this.items.filter(a => a.id !== id); }

  toggle(id) {
    const a = this.items.find(x => x.id === id);
    if (!a) return;
    a.enabled = !a.enabled;
    if (a.enabled) a.triggered = false;
  }

  load(items) {
    this.items = Array.isArray(items) ? items.slice() : [];
    this.seq = this.items.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
  }

  check(symbol, price) {
    if (!symbol || !Number.isFinite(price)) return;
    const sym = symbol.toUpperCase();
    for (const a of this.items) {
      if (!a.enabled || a.triggered || a.symbol !== sym) continue;
      const hit = a.dir === 'above' ? price >= a.price : price <= a.price;
      if (!hit) continue;
      a.triggered = true;
      this.onFire?.(a, price);
    }
  }
}

export function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch { /* 通知不可用时静默降级 */ }
}
