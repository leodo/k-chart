async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const api = {
  symbols: () => getJSON('/api/symbols'),
  bars: (symbol, period, limit = 1500) =>
    getJSON(`/api/bars?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`),
  vixList: () => getJSON('/api/vix/list'),
  vixSeries: (symbol, period = '1d', days = 260) =>
    getJSON(`/api/vix/series?symbol=${encodeURIComponent(symbol)}&period=${period}&days=${days}`),
};
