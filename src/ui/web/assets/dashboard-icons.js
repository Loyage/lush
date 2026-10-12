// Fixed view boxes avoid font-dependent glyph alignment in compact controls.
export function dashboardIcon(kind) {
  const node = (tag, attrs) => {
    const element = document.createElementNS?.('http://www.w3.org/2000/svg', tag) || document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  };
  const svg = node('svg', { viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
  if (kind === 'settings') {
    svg.append(node('path', { d: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z' }), node('circle', { cx: '12', cy: '12', r: '3' }));
  } else {
    svg.append(node('path', { d: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M18 17a7 7 0 0 1-12 1l-2-3' }));
  }
  return svg;
}
