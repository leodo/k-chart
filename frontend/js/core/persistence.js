/** localStorage 薄封装：分区保存布局与命名模板，失败时静默降级。 */
const LAYOUT_KEY = 'kchart:layout:v1';
const TEMPLATE_KEY = 'kchart:templates:v1';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (err) { console.warn('[persistence] write failed', err); return false; }
}

export const persistence = {
  get(section, fallback = null) {
    const data = read(LAYOUT_KEY, {});
    return section ? (data[section] ?? fallback) : data;
  },

  set(section, value) {
    const data = read(LAYOUT_KEY, {});
    data[section] = value;
    return write(LAYOUT_KEY, data);
  },

  templates() { return read(TEMPLATE_KEY, {}); },

  saveTemplate(name, layout) {
    const all = this.templates();
    all[name] = { layout, savedAt: Date.now() };
    return write(TEMPLATE_KEY, all);
  },

  loadTemplate(name) { return this.templates()[name]?.layout || null; },

  deleteTemplate(name) {
    const all = this.templates();
    if (!all[name]) return false;
    delete all[name];
    return write(TEMPLATE_KEY, all);
  },
};
