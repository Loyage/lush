import { expect, test } from 'bun:test';
import { setup, fetch } from './harness.js';
import { installDom, deepText } from '../dom-stub.js';
import { until } from '../helpers.js';
import { loadDetail, disposeDetailRequests } from '../../src/ui/web/assets/detail.js';
import { resetUiState } from '../../src/ui/web/assets/state.js';

// Real SQLite → Project → RPC → HTTP → progressively rendered local tree.
test('Worker detail shows its parent and all direct children across pages, preserving the opened range and refreshing statuses', async () => {
  const f = await setup(); let dom;
  f.project.kick = () => {};
  const create = (parent, kind, goal) => f.store.create({ parent_id: parent, role: 'agent', task_kind: kind, goal });
  try {
    const parent = create(null, 'main', 'main 分支管理'), selected = create(parent.id, 'order', '关系集成');
    f.store.update(parent.id, { status: 'waiting' });
    f.store.run('UPDATE tasks SET worker_number=?,auto_title=? WHERE id=?', 'W227', '当前工作', selected.id);
    create(parent.id, 'order', '不应出现的兄弟');
    const children = [];
    f.store.transaction(() => {
      for (let index = 1; index <= 120; index++) {
        const child = create(selected.id, 'child', `子目标 ${index}`); children.push(child);
        f.store.run('UPDATE tasks SET worker_number=?,display_title=? WHERE id=?', `W227-${index}`, `子标题 ${index}`, child.id);
        f.store.update(child.id, { status: ['running', 'failed', 'cancelled', 'completed'][index % 4], integration: index % 4 === 3 ? 'merged' : 'none' });
      }
    });
    create(children[0].id, 'child', '不应出现的孙辈');
    f.store.event(children[2].id, 'task.accepted', { actor: 'user' });
    const requests = [];
    dom = installDom({ fetch: (url, options) => { requests.push(String(url)); return fetch(f.url + url, options); } });
    resetUiState();
    expect(await loadDetail(selected.id)).toBe(true);
    const panel = dom.node('detail'), section = panel.querySelector('.worker-relations');
    const list = () => section.querySelector('.worker-relation-children').children;
    await until(() => deepText(section).includes('50 / 120'));
    expect(list()).toHaveLength(50);
    expect(section.querySelector('.worker-relation-tree').children[0].querySelector('.worker-relation-row').dataset.workerId).toBe(String(parent.id));
    expect(deepText(section)).toContain('main 分支管理'); expect(deepText(section)).toContain('静息');
    expect(deepText(section)).toContain('W227-3'); expect(deepText(section)).toContain('已合并');
    expect(deepText(section)).not.toContain('不应出现');
    await section.querySelector('.worker-relations-more').onclick();
    expect(list()).toHaveLength(100);
    await section.querySelector('.worker-relations-more').onclick();
    expect(list()).toHaveLength(120);
    expect(section.querySelector('.worker-relations-more')).toBeNull();
    expect(list().map(item => Number(item.querySelector('.worker-relation-row').dataset.workerId))).toEqual(children.map(child => child.id));
    f.store.update(children[119].id, { status: 'running', interrupt_state: 'requested' });
    requests.length = 0;
    await loadDetail(selected.id);
    expect(panel.querySelector('.worker-relations')).toBe(section);
    expect(list()).toHaveLength(120);
    await until(() => deepText(list()[119]).includes('中断请求中'));
    expect(requests.filter(url => url.includes('/relations?')).map(url => new URL(url, 'http://test').searchParams.get('after')))
      .toEqual(['0', String(children[49].id), String(children[99].id)]);
    expect(deepText(section)).toContain('120 / 120'); expect(deepText(section)).not.toContain('不应出现');
    expect(section.querySelector('.worker-relations-more')).toBeNull();
  } finally {
    disposeDetailRequests(); resetUiState(); dom?.restore(); await f.close();
  }
});
