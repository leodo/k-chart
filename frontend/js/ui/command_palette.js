/** 命令面板：/ 或 Ctrl+K 唤起，支持标题/分组/拼音式子串过滤、方向键与回车。 */
export class CommandPalette {
  constructor() {
    this.root = document.getElementById('cmd-palette');
    this.input = document.getElementById('cmd-input');
    this.list = document.getElementById('cmd-list');
    this.commands = [];
    this.filtered = [];
    this.cursor = 0;

    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.execute(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.root.addEventListener('pointerdown', e => {
      if (e.target === this.root) this.close();
    });
    document.addEventListener('keydown', e => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
        || e.target instanceof HTMLTextAreaElement;
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        this.open();
      } else if (e.key === 'Escape' && !this.root.hidden) this.close();
    });
  }

  get isOpen() { return !this.root.hidden; }

  setCommands(commands) { this.commands = commands; }

  open() {
    this.root.hidden = false;
    this.input.value = '';
    this.render();
    this.input.focus();
  }

  close() { this.root.hidden = true; }

  render() {
    const q = this.input.value.trim().toLowerCase();
    this.filtered = this.commands.filter(c =>
      !q || `${c.title} ${c.group || ''} ${c.keywords || ''}`.toLowerCase().includes(q)).slice(0, 40);
    this.cursor = Math.max(0, Math.min(this.cursor, this.filtered.length - 1));
    this.list.replaceChildren(...this.filtered.map((c, i) => {
      const btn = document.createElement('button');
      btn.className = `cmd-item${i === this.cursor ? ' active' : ''}`;
      btn.innerHTML = `<span>${c.title}</span><small>${c.group || ''}</small>`;
      btn.addEventListener('mouseenter', () => { this.cursor = i; this.highlight(); });
      btn.addEventListener('click', () => { this.close(); c.run(); });
      return btn;
    }));
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent = '没有匹配命令';
      this.list.appendChild(empty);
    }
  }

  highlight() {
    [...this.list.children].forEach((el, i) => el.classList.toggle('active', i === this.cursor));
  }

  move(delta) {
    if (!this.filtered.length) return;
    this.cursor = (this.cursor + delta + this.filtered.length) % this.filtered.length;
    this.highlight();
    this.list.children[this.cursor]?.scrollIntoView({ block: 'nearest' });
  }

  execute() {
    const cmd = this.filtered[this.cursor];
    if (!cmd) return;
    this.close();
    cmd.run();
  }
}
