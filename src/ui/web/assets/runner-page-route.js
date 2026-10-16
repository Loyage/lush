/** One route contract for global navigation, source links and old settings bookmarks. */
export const RUNNERS_PAGE = 'runners';
export function runnersHash(projectId = '') {
  if (projectId && !/^[a-f0-9]{16}$/.test(projectId)) throw new Error('需要已登记的来源项目 ID');
  return projectId ? `#runners-project-${projectId}` : '#runners';
}
export function runnersTarget(hash) {
  if (hash === '#runners' || hash === '#settings-runners') return { projectId: '' };
  const match = /^#runners-project-([a-f0-9]{16})$/.exec(hash);
  return match ? { projectId: match[1] } : null;
}
export function runnersLink(projectId = '') { return `/${runnersHash(projectId)}`; }
