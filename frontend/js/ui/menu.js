/** 轻量弹出菜单：按钮在工具栏，菜单挂在 #chart 内，点击外部自动关闭。 */
export function bindMenu(button, menu, items, onPick) {
  menu.hidden = true;

  const render = () => {
    menu.replaceChildren(...items.map(item => {
      const btn = document.createElement('button');
      btn.className = item.active ? 'menu-item active' : 'menu-item';
      btn.textContent = item.label;
      if (item.hint) btn.title = item.hint;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        onPick(item);
        menu.hidden = true;
      });
      return btn;
    }));
  };

  button.addEventListener('click', e => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return; }
    render();
    menu.hidden = false;
    const chartRect = document.getElementById('chart').getBoundingClientRect();
    const br = button.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(br.left - chartRect.left, chartRect.width - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, br.bottom - chartRect.top + 3)}px`;
  });

  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== button) menu.hidden = true;
  });

  return {
    render,
    close() { menu.hidden = true; },
    setItems(next) { items = next; render(); },
    /** 图表内按钮没有 DOM 元素，用鼠标坐标定位菜单。 */
    openAt(clientX, clientY) {
      render();
      menu.hidden = false;
      const chartRect = document.getElementById('chart').getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(clientX - chartRect.left, chartRect.width - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(clientY - chartRect.top, chartRect.height - menu.offsetHeight - 4))}px`;
    },
  };
}
