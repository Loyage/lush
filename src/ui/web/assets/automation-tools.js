import { el, badge, block } from './dom.js';
import { absolute } from './format.js';
import { automationModule } from './automation-module.js';
import { agentHelp } from './help.js';

const TOOLS = ['request_merge', 'accept_worker', 'integrate_deliveries'];
const STATUSES = { submitted: '请求已提交', waiting: '操作等待', running: '操作执行中', succeeded: '操作已完成', failed: '操作失败', unknown: '操作结果未知·需核查' };
export const isDeliveryHandler = mount => mount?.id === 'delivery-handler' || mount?.kind === 'delivery_handler';
const systemTool = mount => mount?.actions?.find(action => TOOLS.includes(action.type))?.type;
export function validOperation(value, mount = null) {
  return value?.version === 1 && typeof value.id === 'string' && value.id.length > 0
    && TOOLS.includes(value.tool) && (!mount || value.tool === systemTool(mount))
    && Object.hasOwn(STATUSES, value.status) && Number.isSafeInteger(value.worker_id) && value.worker_id > 0
    && (value.strategy === undefined || ['serial', 'converge'].includes(value.strategy));
}
export function hookResultLabel(mount, status) {
  if (status === 'succeeded' && systemTool(mount) === 'request_merge') return '请求提交完成（非交付完成）';
  return null;
}
export function operationAlert(mount) {
  const operation = mount?.operation;
  if (!validOperation(operation, mount) || !['failed', 'unknown'].includes(operation.status)) return '';
  return `${STATUSES[operation.status]}${typeof operation.error === 'string' && operation.error ? ` · ${operation.error}` : ''}`;
}
export function renderOperation(mount) {
  if (!systemTool(mount)) return null;
  const node = el('div', undefined, 'hook-operation');
  const operation = mount.operation;
  if (!validOperation(operation, mount)) {
    node.append(el('p', operation == null ? '暂无真实操作证据；不能从配置或 Hook 提交结果推断已经合入或验收。' : '操作证据不可用或版本不兼容；请只读刷新核查，不推断成功。', 'hint'));
    return node;
  }
  node.dataset.operationId = operation.id;
  const completed = operation.status === 'succeeded';
  const result = completed ? ({ request_merge: '本轮交付完成', accept_worker: '安全验收及资源回收完成', integrate_deliveries: '目标交付处理完成' })[operation.tool] : STATUSES[operation.status];
  node.append(el('p', `真实操作：${result} · ${operation.tool}${operation.strategy ? ` · ${operation.strategy === 'converge' ? '归并' : '普通串行'}` : ''}`, ['failed', 'unknown'].includes(operation.status) ? 'error' : 'hint'));
  const identifiers = [['交付', operation.delivery_id], ['归并批次', operation.run_id], ['代次', operation.generation], ['轮次', operation.round]]
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0).map(([label, value]) => `${label} ${value}`);
  if (identifiers.length) node.append(el('p', identifiers.join(' · '), 'hint'));
  if (operation.created_at || operation.finished_at) node.append(el('p', `提交 ${absolute(operation.created_at)}${operation.finished_at ? ` · 结束 ${absolute(operation.finished_at)}` : ''}`, 'hint'));
  if (typeof operation.error === 'string' && operation.error) node.append(el('p', operation.error, 'error'));
  if (completed && operation.tool === 'request_merge') node.append(el('p', '交付完成不表示一定产生代码合并；无代码回答也可完成交付，代码合入以对应交付事实为准。', 'hint'));
  if (!completed) node.append(el('p', '提交、等待或执行不代表真实完成；失败或未知不自动重放。', 'hint'));
  return node;
}

/** Protected system mount, shared by Worker detail and the project target editor. */
export function deliveryHandlerCard({ mount = null, policy = null, control = null, legacy = false } = {}) {
  const card = el('article', undefined, 'hook-mount delivery-handler');
  if (mount) card.dataset.hookId = mount.id;
  const head = el('div', undefined, 'hook-mount-head');
  head.append(el('strong', mount?.name || (legacy ? '目标归并策略（兼容读面）' : '处理已授权交付')), badge('目标策略'));
  if (!legacy) head.append(badge('系统受保护'));
  card.append(head, el('p', legacy ? '旧服务未提供目标系统工具挂载；保留原归并配置入口，不制造新操作记录。' : '工具：integrate_deliveries · 接收已授权交付（delivery.requested）', 'hint'));
  const strategy = mount?.actions?.find(item => item.type === 'integrate_deliveries')?.strategy;
  const strategyNode = el('p', undefined, 'hint delivery-handler-strategy');
  card.updatePolicy = value => {
    const selected = value && typeof value.mounted === 'boolean' && typeof value.enabled === 'boolean' ? value.mounted && value.enabled ? 'converge' : 'serial'
      : ['serial', 'converge'].includes(strategy) ? strategy : null;
    strategyNode.textContent = selected ? `当前处理策略：${selected === 'converge' ? '归并' : '普通串行'}${legacy ? '（旧策略读面）。' : '；处理器持续启用。'}` : '处理策略尚未确认；请只读刷新，不推断配置。';
  };
  card.updatePolicy(policy); card.append(strategyNode);
  card.append(el('p', '仅处理已授权交付，不提高来源 Worker 的自动合并或验收权限。归并关闭或未挂载时仍以普通串行处理合法交付；策略在固定事务时选定，已有操作不撤回。', 'hint'));
  if (!legacy) card.append(el('p', '这是系统工具挂载，不可作为普通规则编辑、复制或移除；归并配置仍使用现有目标分支设置。', 'hint'));
  if (control) card.append(control);
  if (mount) card.append(renderOperation(mount) || el('p', '操作证据尚未提供。', 'hint'));
  else card.append(el('p', '系统挂载或操作证据尚未提供；旧服务的目标归并配置仍可使用。', 'hint'));
  if (mount?.reason) card.append(el('p', mount.reason, 'hint'));
  return card;
}

/** Catalogue is descriptive only: no workflow editor or implicit installation. */
export function renderAutomationTools(catalogue, folds) {
  const node = block('自动化工具与节点'); node.classList.add('automation-tools');
  node.append(el('p', '工具说明不是执行授权。来源结束规则请求交付，目标处理策略接收已授权交付，验收工具受原最高级别和安全门约束。', 'hint'));
  for (const tool of catalogue.actions || []) {
    const card = el('article', undefined, 'hook-tool'); card.dataset.tool = tool.type;
    const head = el('div', undefined, 'hook-mount-head'); head.append(el('strong', tool.label || tool.type), el('code', tool.type));
    if (tool.builtin_only) head.append(badge('仅系统挂载'));
    if (tool.execution === 'operation') head.append(badge('持久操作'));
    if (tool.agent_call) { const cost = badge('可能调用 Agent', 'agent-call'); cost.tabIndex = 0; cost.setAttribute('data-help', agentHelp('授权后在安全点可能安排调用，目录说明本身不会执行。')); head.append(cost); }
    card.append(head);
    if (tool.description) card.append(el('p', tool.description, 'hint'));
    if (tool.type === 'request_merge') card.append(el('p', 'Hook 成功只表示请求提交完成，不等于本轮交付完成；交付完成以真实操作证据为准，代码是否合入须查看对应交付事实。', 'hint'));
    if (tool.type === 'accept_worker') card.append(el('p', '仅由现有结束最高级别授权，不开放自定义验收；验收含安全资源回收，不是质量评审。', 'hint'));
    if (tool.type === 'integrate_deliveries') card.append(el('p', '目标系统处理器：普通串行（serial）或归并（converge）。归并开关只选择处理策略，不是停止所有合并，也不授予来源交付或验收权限。', 'hint'));
    if (tool.triggers?.length) card.append(el('p', `节点：${tool.triggers.map(id => catalogue.triggers?.find(item => item.id === id)?.label || id).join(' · ')}`, 'hint'));
    node.append(card);
  }
  const triggers = el('div', undefined, 'hook-tool-triggers');
  for (const trigger of catalogue.triggers || []) triggers.append(el('p', `${trigger.label || trigger.id} · ${trigger.id}${trigger.description ? `：${trigger.description}` : ''}`, 'hint'));
  node.append(triggers);
  if (!catalogue.actions?.length) node.append(el('p', '工具目录尚未提供；不猜测新的权限或操作能力。', 'hint'));
  if (!catalogue.actions?.some(item => item.type === 'integrate_deliveries')) node.append(el('p', '旧服务未提供目标处理工具目录，保留现有归并设置；不制造新挂载或操作证据。', 'hint'));
  return automationModule(node, 'tools', folds, `${catalogue.actions?.length || 0} 个工具；系统操作与规则提交分开显示。`);
}
