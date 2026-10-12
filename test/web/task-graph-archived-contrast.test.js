import { test, expect } from 'bun:test';

const css = await Bun.file(new URL('../../src/ui/web/assets/styles.css', import.meta.url)).text();
const rule = selector => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1];
const rgb = hex => {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(digit => digit + digit).join('');
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
};
const mix = (front, back, weight) => front.map((value, index) => value * weight + back[index] * (1 - weight));
const luminance = color => color.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const contrast = (first, second) => {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};

test('archived history toggle overrides solid-button ink and stays readable while hidden', () => {
  expect(rule('.task-graph-archived-toggle')).toContain('color:var(--text)');
  expect(rule('.task-graph-archived-toggle[aria-pressed="false"]')).toContain('opacity:1');
  // Equal specificity: the archived override must follow the faded status-toggle rule.
  expect(css.indexOf('.task-graph-archived-toggle[aria-pressed="false"]')).toBeGreaterThan(
    css.indexOf('.task-graph-status-toggle[aria-pressed="false"]'));
  // Keep the existing visual distinction and pressed-state semantics.
  expect(rule('.task-graph-status-toggle[aria-pressed="false"]')).toContain('border-style:dashed');
  expect(rule('.task-graph-status-toggle[aria-pressed="false"]')).toContain('text-decoration:line-through');
});

for (const theme of ['light', 'dark']) {
  test(`archived history label meets 4.5:1 contrast in ${theme} theme, including hover`, () => {
    const tokens = rule(theme === 'light' ? ':root' : ':root[data-theme="dark"]');
    const token = name => rgb(tokens.match(new RegExp(`--${name}:(#[\\da-f]{3,6})`))[1]);
    const text = token('text');
    const normalWeight = Number(rule('.badge').match(/background:color-mix\(in srgb,currentColor (\d+)%/)[1]) / 100;
    const hoverWeight = Number(rule('.task-graph-status-toggle:hover').match(/currentColor (\d+)%/)[1]) / 100;
    for (const background of [token('bg'), token('panel')]) {
      for (const weight of [normalWeight, hoverWeight]) {
        expect(contrast(text, mix(text, background, weight))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
}
