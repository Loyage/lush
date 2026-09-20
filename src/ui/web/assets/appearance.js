// Runs before CSS/first paint. No inline script, remote font or framework required.
(() => {
  const root = document.documentElement;
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  let preference = null;
  try {
    const saved = localStorage.getItem('lush.theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* Storage can be unavailable in private/embedded browsers. */ }
  let current;
  function apply(theme) {
    current = theme;
    root.dataset.theme = theme;
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    toggle.textContent = theme === 'dark' ? '☀ 浅色' : '☾ 深色';
    toggle.title = `当前为${theme === 'dark' ? '深色' : '浅色'}主题，点击切换`;
    toggle.setAttribute('aria-label', `切换到${theme === 'dark' ? '浅色' : '深色'}主题`);
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  apply(preference ?? (system?.matches ? 'dark' : 'light'));
  system?.addEventListener?.('change', event => {
    if (!preference) apply(event.matches ? 'dark' : 'light');
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply(current);
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.onclick = () => {
      preference = current === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('lush.theme', preference); } catch { /* Keep it for this page. */ }
      apply(preference);
    };
  }, { once: true });
})();
