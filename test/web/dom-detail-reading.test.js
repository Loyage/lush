import { test, expect } from 'bun:test';
import { installDom } from '../dom-stub.js';
import { block, el } from '../../src/ui/web/assets/dom.js';
import { captureDetailReading, restoreDetailReading } from '../../src/ui/web/assets/detail-reading.js';

function fixture(run, page = false) {
  const dom = installDom(), panel = dom.node('detail');
  dom.window.innerWidth = page ? 390 : 1440; dom.window.innerHeight = 900;
  dom.window.matchMedia = () => ({ matches: page });
  dom.window.scrollY = page ? 500 : 0; dom.window.scrollX = 0;
  dom.window.scrollTo = ({ top }) => { dom.window.scrollY = top; };
  panel.scrollTop = page ? 0 : 500;
  panel.getBoundingClientRect = () => ({ top: 0, bottom: 900 });
  const module = block('消息'), text = el('p', '正在读的正文'); module.append(text); panel.append(module);
  let shift = 0;
  const scroll = () => page ? dom.window.scrollY : panel.scrollTop;
  module.getBoundingClientRect = () => ({ top: 400 + shift - scroll(), bottom: 1500 + shift - scroll() });
  text.getBoundingClientRect = () => ({ top: 650 + shift - scroll(), bottom: 690 + shift - scroll() });
  try { run({ panel, module, text, dom, shift: value => { shift = value; }, scroll }); } finally { dom.restore(); }
}

for (const page of [false, true]) test(`正文锚点补偿上方增长/回缩，不以标题吸顶坐标为锚：${page ? '手机页面' : '桌面详情'}`, () => fixture(({ panel, text, shift, scroll }) => {
  const saved = captureDetailReading(panel);
  expect(saved.anchor).toBe(text); expect(saved.anchorTop).toBe(150);
  shift(180); restoreDetailReading(panel, saved);
  expect(scroll()).toBe(680); expect(text.getBoundingClientRect().top).toBe(150);
  const next = captureDetailReading(panel);
  shift(-40); restoreDetailReading(panel, next);
  expect(scroll()).toBe(460); expect(text.getBoundingClientRect().top).toBe(150);
}, page));

test('重绘空面板导致滚动被 clamp 时不重复计入位移；替换模块找回正文', () => fixture(({ panel, module, text, shift, scroll }) => {
  const saved = captureDetailReading(panel);
  const replacement = block('消息'), next = el('p', '正在读的正文'); replacement.append(next);
  replacement.getBoundingClientRect = module.getBoundingClientRect; next.getBoundingClientRect = text.getBoundingClientRect;
  panel.replaceChildren(replacement); panel.scrollTop = 0; shift(80);
  restoreDetailReading(panel, saved);
  expect(scroll()).toBe(580); expect(next.getBoundingClientRect().top).toBe(150);
}));

test('窗口变化尊重重排；锚点模块消失后回退原滚动量', () => fixture(({ panel, dom, shift, scroll }) => {
  const saved = captureDetailReading(panel); shift(100); dom.window.innerHeight = 700;
  restoreDetailReading(panel, saved); expect(scroll()).toBe(500);
  dom.window.innerHeight = 900; panel.replaceChildren(); panel.scrollTop = 0;
  restoreDetailReading(panel, saved); expect(scroll()).toBe(500);
}));
