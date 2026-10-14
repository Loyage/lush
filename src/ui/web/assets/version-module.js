import { enhanceModule } from './shared-module.js';

/** Use the page's shared preview, retaining async diagnostics outside its clipped body. */
export function enhanceVersionModule(root, feedback) {
  root.classList.add('block');
  const view = enhanceModule(root, { key: '版本迭代:0' });
  feedback.remove(); view.summary.replaceChildren(feedback); view.summary.hidden = false;
  const host = globalThis.window || globalThis;
  const banners = document.getElementById('notice-banner')?.parentNode;
  const measure = () => {
    if (!view.active) return;
    const height = banners?.getBoundingClientRect?.().height || 0;
    root.style.setProperty('--versions-banner-height', `${height}px`);
  };
  let observer = null;
  if (banners && typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(measure); observer.observe(banners);
  }
  host.addEventListener?.('resize', measure); measure();
  view.onDispose(() => { observer?.disconnect(); host.removeEventListener?.('resize', measure); });
  return view;
}
