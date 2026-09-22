// Static HTML only. CSP is enforced as an HTTP header (not inherited from the main page).
// A whitelist also removes navigations (meta refresh, links, forms) that sandbox alone permits.
const TAGS = new Set('html head body title style div span main section article header footer nav aside h1 h2 h3 h4 h5 h6 p br hr pre code strong em b i u s small blockquote ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col figure figcaption img button label input textarea select option progress meter details summary'.split(' '));
const ATTRS = new Set('class style title role aria-label aria-hidden colspan rowspan scope width height alt type value placeholder min max step checked selected open disabled'.split(' '));
export const PREVIEW_CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function previewResponse(html, headers = {}) {
  const response = new Response(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
  });
  return new HTMLRewriter().on('*', {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (!TAGS.has(tag)) { element.remove(); return; }
      for (const [name, value] of [...element.attributes]) {
        if (tag === 'img' && name === 'src' && /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) continue;
        if (!ATTRS.has(name)) element.removeAttribute(name);
      }
      // Controls are illustrative, not a second way of answering the questionnaire.
      if (['button', 'input', 'textarea', 'select'].includes(tag)) element.setAttribute('disabled', '');
    },
  }).transform(response);
}
