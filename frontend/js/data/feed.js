/** WebSocket 实时行情：断线指数退避重连，订阅状态自恢复。 */
export class Feed {
  constructor(onTick, onStatus, onBars) {
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.onBars = onBars;
    this.ws = null;
    this.retry = 0;
    this.timer = null;
    this.sub = null;
    this.closed = false;
  }

  connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus?.('已连接');
      if (this.sub) this.sendSubscribe(this.sub);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (!this.sub || msg.symbol !== this.sub.symbol || msg.period !== this.sub.period) return;
        if (msg.type === 'tick') {
          this.onTick(msg);
        } else if (msg.type === 'bars') {
          this.onBars?.(msg.bars);
        } else if (msg.type === 'error') {
          this.onStatus?.(msg.message, true);
        }
      } catch (err) { console.warn('[feed] bad message', err); }
    };
    ws.onclose = () => {
      this.onStatus?.('重连中…', true);
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  sendSubscribe(sub) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', ...sub }));
    }
  }

  subscribe(symbol, period) {
    this.sub = { symbol, period };
    this.sendSubscribe(this.sub);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
