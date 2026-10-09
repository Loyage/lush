import { test, expect } from 'bun:test';
import { PROJECT_COLORS } from '../../src/ui/web/assets/project-colors.js';

const css = await Bun.file(new URL('../../src/ui/web/assets/styles-appearance.css', import.meta.url)).text();
const rgb = hex => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
const mix = (front, back, percent) => front.map((value, index) => value * percent + back[index] * (1 - percent));
const luminance = color => color.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const contrast = (first, second) => {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};

test('all six project palettes keep ordinary text readable on tinted sidebar and selected items', () => {
  const palettes = new Map([...css.matchAll(/:root\[data-project-color="([a-z]+)"\][^\n]+--project-light:(#[\da-f]{6});--project-dark:(#[\da-f]{6})/g)]
    .map(([, id, light, dark]) => [id, { light, dark }]));
  expect([...palettes.keys()]).toEqual(PROJECT_COLORS.map(color => color.id));
  // Use the actual CSS mixing weights so a later tint change cannot silently
  // invalidate these checks; Firefox regression separately verifies rendered CSS.
  const sidebarLight = Number(/--sidebar:color-mix\(in srgb,var\(--accent\) (\d+)%/.exec(css)[1]) / 100;
  const sidebarDark = Number(/data-theme="dark"\]\[data-project-color\][^\n]+--sidebar:color-mix\(in srgb,var\(--accent\) (\d+)%/.exec(css)[1]) / 100;
  const selectedLight = Number(/--accent-soft:color-mix\(in srgb,var\(--accent\) (\d+)%/.exec(css)[1]) / 100;
  const selectedDark = Number(/data-theme="dark"\]\[data-project-color\][^\n]+--accent-soft:color-mix\(in srgb,var\(--accent\) (\d+)%/.exec(css)[1]) / 100;
  for (const palette of palettes.values()) {
    const light = rgb(palette.light), dark = rgb(palette.dark), white = rgb('#ffffff'), ink = rgb('#111719');
    expect(contrast(light, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light, mix(light, white, sidebarLight))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light, mix(light, white, selectedLight))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, mix(dark, ink, sidebarDark))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, mix(dark, rgb('#1a2325'), selectedDark))).toBeGreaterThanOrEqual(4.5);
  }
});
