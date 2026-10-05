import { test, expect, afterAll } from 'bun:test';
import { installDom, dialogButton, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { makeWorld } from './dom-world.js';

// 新建指令的运行设置：Lush 配置（默认）或 Pi 默认配置；只打开设置、不调用 Agent；
// 确认后随本条 order.submit 一起发送，创建成功即回到项目默认。
const world = makeWorld();
let failSubmit = false;
const dom = installDom({ fetch: (url, options = {}) => {
  const path = String(url);
  if (failSubmit && path === '/api/action') {
    const body = JSON.parse(options.body);
    if (body.method === 'order.submit') return Promise.reject(new Error('网络失败'));
  }
  return world.fetchImpl(url, options);
} });
const { boot } = await import('../../src/ui/web/assets/app.js');
const { ui } = await import('../../src/ui/web/assets/state.js');
const { overview, detail } = await import('../../src/ui/web/assets/navigate.js');
const { paintRunSettings } = await import('../../src/ui/web/assets/composer.js');
await boot();
afterAll(() => dom.restore());

// stub 的 DOM 是扁平的 byId 节点：动态按钮挂在 composer-shell 下。
const CONNECTION = '11111111-1111-4111-8111-111111111111';
const button = () => dom.node('composer-shell').querySelector('.composer-run-settings');
const runSettingsButton = button();
const lastOrder = () => [...world.state.actions].reverse().find(row => row.method === 'order.submit');
const createWorker = async content => {
  dom.node('input').value = content; dom.node('input').oninput({});
  await dom.node('input-form').onsubmit({ preventDefault() {} });
  await until(() => !ui.composerSubmitting);
};
const openDialog = async () => {
  await overview();
  world.state.actions.length = 0;
  // 点击会一直等到用户作答，不能在 openDialog 里 await。
  void button().onclick();
  await until(() => dialogButton(dom, '使用这份设置'));
  return dom.node('modal');
};
const setMode = (modal, mode) => { const select = modal.querySelector('[data-retry-field="config_mode"]'); select.value = mode; select.onchange(); return select; };

test('运行设置入口默认沿用项目默认，只打开设置、不调用 Agent', async () => {
  await overview();
  expect(button()).toBe(runSettingsButton);
  expect(button().textContent).toBe('运行设置：项目默认');
  expect(button().classList.contains('agent-call')).toBe(false);
  expect(button().getAttribute('data-help')).toContain('不调用 Agent');
  expect(button().getAttribute('data-help')).toContain('自动继承');
  const modal = await openDialog();
  expect(deepText(modal)).toContain('Lush 配置');
  expect(deepText(modal)).toContain('Pi 默认配置');
  expect(modal.querySelector('[data-retry-field="config_mode"]').value).toBe('lush');
  expect(dialogButton(dom, '使用这份设置').classList.contains('agent-call')).toBe(false);
  expect(world.state.actions.filter(row => row.method === 'order.submit')).toHaveLength(0);
  await dialogButton(dom, '取消').onclick();
  expect(button().textContent).toBe('运行设置：项目默认');
});

test('Lush 配置缺少托管来源时不提交，确认后重新打开表单且不丢掉编辑', async () => {
  const modal = await openDialog();
  const model = modal.querySelector('[data-retry-field="model"]');
  model.value = 'deepseek/deepseek-flash';
  await dialogButton(dom, '使用这份设置').onclick();
  await until(() => dialogButton(dom, '使用这份设置'));
  expect(dom.node('error').textContent).toContain('请选择 Lush 模型来源');
  expect(button().textContent).toBe('运行设置：项目默认');
  expect(dom.node('modal').querySelector('[data-retry-field="model"]').value).toBe('deepseek/deepseek-flash');
  await dialogButton(dom, '取消').onclick();
});

test('Lush 配置随本条指令提交完整 Profile，创建成功后回到项目默认', async () => {
  const modal = await openDialog();
  await dialogButton(dom, '读取项目连接').onclick();
  const connection = modal.querySelector('[data-retry-field="connection_id"]');
  connection.value = CONNECTION; connection.onchange();
  const model = modal.querySelector('[data-retry-field="model"]');
  model.value = 'openai-compatible/fixture-model';
  await dialogButton(dom, '使用这份设置').onclick();
  expect(button().textContent).toBe('运行设置：Lush 配置');
  await createWorker('用 Lush 配置跑');
  const params = lastOrder().params;
  expect(params.profile).toMatchObject({ agent: 'pi', config_mode: 'lush', connection_id: CONNECTION, model: 'openai-compatible/fixture-model' });
  expect(params.profile).toHaveProperty('extensions');
  expect(button().textContent).toBe('运行设置：项目默认');
});

test('Pi 默认模式只提交后端与模式，不带托管来源、模型或资源', async () => {
  const modal = await openDialog();
  const managed = modal.querySelector('[data-config-managed="managed"]');
  setMode(modal, 'pi');
  expect(managed.hidden).toBe(true);
  expect(deepText(modal)).toContain('不自动批准未受信项目');
  await dialogButton(dom, '使用这份设置').onclick();
  expect(button().textContent).toBe('运行设置：Pi 默认配置');
  await createWorker('用 Pi 默认配置跑');
  expect(lastOrder().params.profile).toEqual({ agent: 'pi', config_mode: 'pi' });
  expect(button().textContent).toBe('运行设置：项目默认');
});

test('恢复项目默认清除本条覆盖，之后提交不带 profile', async () => {
  const modal = await openDialog();
  setMode(modal, 'pi');
  await dialogButton(dom, '使用这份设置').onclick();
  expect(button().textContent).toBe('运行设置：Pi 默认配置');
  await openDialog();
  await dialogButton(dom, '恢复项目默认（本条不覆盖）').onclick();
  expect(button().textContent).toBe('运行设置：项目默认');
  await createWorker('不覆盖运行设置');
  expect(lastOrder().params).not.toHaveProperty('profile');
});

test('提交失败保留输入与已选运行设置，重试成功后清空输入', async () => {
  await openDialog();
  setMode(dom.node('modal'), 'pi');
  await dialogButton(dom, '使用这份设置').onclick();
  failSubmit = true;
  await createWorker('失败的输入');
  expect(dom.node('error').textContent).toContain('网络失败');
  expect(dom.node('input').value).toBe('失败的输入');
  expect(button().textContent).toBe('运行设置：Pi 默认配置');
  failSubmit = false;
  await createWorker('失败的输入');
  expect(lastOrder().params.profile).toEqual({ agent: 'pi', config_mode: 'pi' });
  expect(dom.node('input').value).toBe('');
});

test('追加输入模式隐藏运行设置入口，返回概览后恢复', async () => {
  await detail(1);
  expect(dom.node('input-form').dataset.mode).toBe('append');
  paintRunSettings();
  expect(button().hidden).toBe(true);
  await overview();
  expect(button().hidden).toBe(false);
});

test('运行设置可按来源默认一键填入模型与思考深度，未读来源给出提示且不调用 Agent', async () => {
  const connection = world.state.agentConnections.connections[0];
  connection.default_model = 'second-model'; connection.default_thinking = 'high';
  try {
    const modal = await openDialog();
    await dialogButton(dom, '填入来源默认（模型 + 思考深度）').onclick();
    expect(deepText(modal)).toContain('请先读取并选择模型来源');
    await dialogButton(dom, '读取项目连接').onclick();
    const select = modal.querySelector('[data-retry-field="connection_id"]');
    select.value = CONNECTION; select.onchange();
    await dialogButton(dom, '填入来源默认（模型 + 思考深度）').onclick();
    expect(modal.querySelector('[data-retry-field="model"]').value).toBe('openai-compatible/second-model');
    expect(modal.querySelector('[data-retry-field="thinking"]').value).toBe('high');
    expect(world.state.actions.filter(row => row.method === 'order.submit')).toHaveLength(0);
    await dialogButton(dom, '取消').onclick();
  } finally {
    delete connection.default_model; delete connection.default_thinking;
  }
});
