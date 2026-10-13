/** UI feature directory only; configuration and execution authority stay in their engines. */
export const AUTOMATION_FEATURES = Object.freeze([
  { id: 'completion', name: '开发完成后自动处理', description: '管理本项目 Worker 的实际合并、验收授权与最近操作记录。', scope: 'Worker 授权 · 设备默认',
    load: () => import('./automation-feature-pages.js').then(module => module.renderCompletionAutomation) },
  { id: 'push', name: '合并后自动 git push', description: '管理 main 的推送挂载、引用指令的最新定义与执行记录。', scope: '当前项目 · main',
    load: () => import('./automation-feature-pages.js').then(module => module.renderPushAutomation) },
  { id: 'convergence', name: '归并合并', description: '设置目标分支的交付处理策略与未来挂载默认，查看归并批次。', scope: '当前项目 · 目标分支',
    load: () => import('./automation-feature-pages.js').then(module => module.renderBranchConvergence) },
  { id: 'emission', name: '条件发射', description: '设置每条输入的发射条件与独占选项，查看等待和发射收据。', scope: '当前项目 · 输入授权',
    load: () => import('./automation-feature-pages.js').then(module => module.renderEmissionAutomation) },
]);
export const automationFeature = id => AUTOMATION_FEATURES.find(feature => feature.id === id);
export function automationHash(feature = null, subpage = 'settings') {
  return feature ? `#hooks-${feature}${subpage === 'history' ? '-history' : ''}` : '#hooks';
}
export function automationTarget(hash) {
  if (hash === '#hooks' || hash === '#hooks-history') return { feature: null, subpage: 'settings' };
  const match = /^#hooks-(completion|push|convergence|emission)(-history)?$/.exec(hash);
  return match ? { feature: match[1], subpage: match[2] ? 'history' : 'settings' } : null;
}
