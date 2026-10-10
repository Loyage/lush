import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { check, id, isPlainObject } from '../core/types.js';
import { launcherStateDir, projectRouteId } from './registry.js';

const STATUS = new Set(['all','open','unread','automatic','failed']);
const METHODS = new Set(['notice.answer','notice.dismiss','notice.read']);
const FIELDS = ['id','task_id','title','body','status','answer','kind','source_event_id','read_at','created_at',
  'answer_source','task_worker_number','lifecycle_type','sync_identity','sync_revision','sync_epoch'];
const HEX = /^[a-f0-9]{32}$/;
const DISK_LIMIT = 32 * 1024 * 1024;
const RESPONSE_LIMIT = 900000;
const safeId = value => Number.isSafeInteger(value) && value > 0;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function privateStat(stat, directory) {
  return typeof process.getuid === 'function' && stat.uid === process.getuid()
    && !stat.isSymbolicLink() && (directory ? stat.isDirectory() && (stat.mode & 0o777) === 0o700
      : stat.isFile() && (stat.mode & 0o777) === 0o600);
}
function noticeModel(value) {
  check(isPlainObject(value) && safeId(value.id) && safeId(value.task_id)
    && typeof value.title === 'string' && typeof value.body === 'string'
    && typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at))
    && ['open','answered','dismissed','sent'].includes(value.status)
    && ['question','questionnaire','plan','info'].includes(value.kind)
    && HEX.test(value.sync_identity) && HEX.test(value.sync_epoch)
    && Number.isSafeInteger(value.sync_revision) && value.sync_revision >= 0,
  'invalid Notice synchronization record');
  check(value.answer === null || typeof value.answer === 'string', 'invalid Notice answer');
  check(value.read_at === null || typeof value.read_at === 'string', 'invalid Notice read receipt');
  check(value.source_event_id === null || safeId(value.source_event_id), 'invalid Notice source event');
  check([null,'user','lush'].includes(value.answer_source), 'invalid Notice answer source');
  check([null,'created','idle','analysis','failed'].includes(value.lifecycle_type), 'invalid Notice lifecycle type');
  check(value.task_worker_number === null || typeof value.task_worker_number === 'string', 'invalid Notice Worker number');
  const result = Object.fromEntries(FIELDS.map(key => [key, value[key]]));
  check(bytes(result) <= RESPONSE_LIMIT, 'Notice record exceeds inbox byte limit');
  return result;
}
function matches(notice, status) {
  if (status === 'all') return true;
  if (status === 'open') return notice.status === 'open' && ['question','questionnaire'].includes(notice.kind);
  if (status === 'unread') return notice.kind === 'info' && notice.status === 'sent'
    && notice.source_event_id !== null && notice.read_at === null;
  if (status === 'automatic') return notice.status === 'answered' && notice.answer_source === 'lush'
    && ['question','questionnaire'].includes(notice.kind);
  return notice.kind === 'info' && notice.lifecycle_type === 'failed';
}
const keyFor = item => [item.notice.created_at, item.project_id, item.notice.id, item.notice.sync_identity];
function compareKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
function encodeCursor(status, item) {
  return Buffer.from(JSON.stringify({ version: 1, status, key: keyFor(item) })).toString('base64url');
}
function decodeCursor(value, status) {
  check(typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value), 'invalid inbox cursor');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { /* validate below */ }
  check(isPlainObject(parsed) && Object.keys(parsed).every(key => ['version','status','key'].includes(key))
    && parsed.version === 1 && parsed.status === status && Array.isArray(parsed.key) && parsed.key.length === 4
    && typeof parsed.key[0] === 'string' && Number.isFinite(Date.parse(parsed.key[0]))
    && /^[a-f0-9]{16}$/.test(parsed.key[1]) && safeId(parsed.key[2]) && HEX.test(parsed.key[3]), 'invalid inbox cursor');
  return parsed.key;
}
function stateFor(entry) {
  return { id: entry.id, project: entry.project, cursor: null, epoch: null, records: new Map(), online: false,
    checked_at: null, complete: false, limited: false, error: null, retry_at: 0, generation: 0 };
}

/** Derived cross-project view. Every read/action rechecks the current Host registry. */
export class GlobalInboxService {
  constructor(projectHost, options = {}) {
    check(projectHost && typeof projectHost.status === 'function' && typeof projectHost.openRoute === 'function', 'project Host required');
    this.host = projectHost;
    this.env = options.env || process.env;
    this.now = options.now || Date.now;
    this.timeout = options.timeoutMs ?? 4000;
    this.backoff = options.backoffMs ?? 10000;
    this.pages = options.pagesPerRefresh ?? 4;
    this.pageSize = options.pageSize ?? 100;
    this.maxRecords = options.maxRecords ?? 10000;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    for (const value of [this.timeout,this.pages,this.pageSize,this.maxRecords,this.maxBytes]) {
      check(Number.isSafeInteger(value) && value > 0, 'invalid inbox resource limit');
    }
    check(this.pageSize <= 100 && this.pages <= 100 && this.maxBytes <= 24 * 1024 * 1024
      && Number.isSafeInteger(this.backoff) && this.backoff >= 0, 'invalid inbox resource limit');
    this.root = path.join(launcherStateDir(this.env), 'inbox');
    this.file = path.join(this.root, 'cache.json');
    this.dirty = false; this.nextPersist = 0;
    this.states = new Map(); this.pending = new Set(); this.closed = false; this.inflight = null; this.cacheError = null;
    this.loadCache();
  }

  assertOpen() { check(!this.closed, 'global inbox is stopping'); }
  safeRoot(create = false) {
    if (!fs.existsSync(this.root)) {
      if (!create) return false;
      let ancestor = this.root;
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const stat = fs.lstatSync(ancestor);
      check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(ancestor) === ancestor, 'unsafe inbox cache directory');
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(this.root);
    check(privateStat(stat, true) && fs.realpathSync(this.root) === this.root, 'unsafe inbox cache directory');
    return stat;
  }
  loadCache() {
    let fd;
    try {
      if (!this.safeRoot()) return;
      const stat = fs.lstatSync(this.file);
      check(privateStat(stat, false) && stat.size <= DISK_LIMIT, 'unsafe inbox cache file');
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      check(sameFile(stat, fs.fstatSync(fd)), 'inbox cache file changed');
      const cache = JSON.parse(fs.readFileSync(fd, 'utf8'));
      check(isPlainObject(cache) && cache.version === 1 && Array.isArray(cache.projects), 'invalid inbox cache');
      let count = 0, size = 0;
      for (const entry of cache.projects) {
        check(isPlainObject(entry) && typeof entry.project === 'string' && path.isAbsolute(entry.project)
          && projectRouteId(entry.project) === entry.id && !this.states.has(entry.id)
          && (entry.epoch === null || HEX.test(entry.epoch)) && (entry.cursor === null || typeof entry.cursor === 'string')
          && (entry.checked_at === null || typeof entry.checked_at === 'string') && Array.isArray(entry.records), 'invalid inbox cache project');
        const state = stateFor(entry);
        Object.assign(state, { epoch: entry.epoch, cursor: entry.cursor, checked_at: entry.checked_at,
          complete: entry.complete === true, limited: entry.limited === true });
        for (const record of entry.records) {
          const notice = noticeModel(record);
          check(notice.sync_epoch === state.epoch && !state.records.has(notice.id), 'invalid inbox cache record');
          count++; size += bytes(notice);
          check(count <= this.maxRecords && size <= this.maxBytes, 'inbox cache exceeds resource limit');
          state.records.set(notice.id, notice);
        }
        this.states.set(state.id, state);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.states.clear(); this.cacheError = '收件箱缓存不可用；将从来源项目重新读取。'; }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  persist() {
    if (this.closed || (!this.dirty && this.nextPersist > this.now())) return;
    let lock, original, temporary;
    try {
      const root = this.safeRoot(true);
      lock = path.join(this.root, '.write.lock');
      fs.mkdirSync(lock, { mode: 0o700 }); original = fs.lstatSync(lock);
      const assert = () => {
        const current = fs.lstatSync(lock), currentRoot = this.safeRoot();
        check(privateStat(current, true) && sameFile(current, original) && sameFile(root, currentRoot), 'inbox cache lock changed');
      };
      if (fs.existsSync(this.file)) check(privateStat(fs.lstatSync(this.file), false), 'unsafe inbox cache file');
      const value = JSON.stringify({ version: 1, projects: [...this.states.values()].map(state => ({
        id: state.id, project: state.project, epoch: state.epoch, cursor: state.cursor, checked_at: state.checked_at,
        complete: state.complete, limited: state.limited, records: [...state.records.values()],
      })) });
      check(Buffer.byteLength(value) <= DISK_LIMIT, 'inbox cache exceeds disk limit');
      temporary = path.join(this.root, `.cache-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
      assert(); fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); assert();
      fs.renameSync(temporary, this.file); temporary = null; this.cacheError = null;
      this.dirty = false; this.nextPersist = this.now() + 30000;
    } catch {
      this.cacheError = '收件箱缓存未保存；当前在线记录仍可查看，离线记录可能不完整。';
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* own temporary only */ } }
      if (original) { try { if (sameFile(fs.lstatSync(lock), original)) fs.rmdirSync(lock); } catch { /* replaced lock is not ours */ } }
    }
  }

  async entries() {
    this.assertOpen();
    const model = await this.host.status(); this.assertOpen();
    check(Array.isArray(model.projects), 'project registry unavailable');
    const seen = new Set();
    const entries = model.projects.map(row => {
      check(isPlainObject(row) && typeof row.project === 'string' && path.isAbsolute(row.project)
        && projectRouteId(row.project) === row.id && !seen.has(row.id), 'invalid project registry');
      seen.add(row.id);
      return { id: row.id, project: row.project, name: typeof row.name === 'string' ? row.name : path.basename(row.project) };
    });
    for (const key of this.states.keys()) if (!seen.has(key)) { this.states.delete(key); this.dirty = true; }
    return entries;
  }
  async source(projectId) {
    const row = (await this.entries()).find(entry => entry.id === projectId);
    check(row, '未知或无权访问的来源项目');
    let binding;
    try { binding = await this.host.openRoute(row.id); }
    catch { throw new Error('来源项目暂时不可达；未启动后台或提交操作。'); }
    this.assertOpen();
    check(binding?.config?.project === row.project && typeof binding.client?.request === 'function', '来源项目身份不符');
    check((await this.entries()).some(entry => entry.id === row.id), '来源项目已移除或不再允许访问');
    return { row, client: binding.client };
  }
  async request(client, method, params, mutation = false) {
    this.assertOpen();
    let cancel, timer;
    const interrupted = new Promise((_, reject) => {
      cancel = () => reject(new Error(mutation ? '提交结果未确认；请刷新来源记录核对，不要重复提交。' : '来源项目读取已中止'));
      timer = setTimeout(() => reject(new Error(mutation ? '提交结果未确认；请刷新来源记录核对，不要重复提交。' : '来源项目读取超时')), this.timeout);
    });
    this.pending.add(cancel);
    try { return await Promise.race([client.request(method, params), interrupted]); }
    catch (error) {
      const failure = new Error(mutation ? '提交结果未确认；请刷新来源记录核对，不要重复提交。' : '来源项目读取未完成；请稍后刷新。');
      if (error.code === -32601) failure.code = error.code;
      throw failure;
    } finally { clearTimeout(timer); this.pending.delete(cancel); }
  }
  state(row) {
    let state = this.states.get(row.id);
    if (!state || state.project !== row.project) { state = stateFor(row); this.states.set(row.id, state); this.dirty = true; }
    return state;
  }
  applyNotice(state, notice) {
    if (state.epoch !== notice.sync_epoch) {
      state.records.clear(); state.epoch = notice.sync_epoch; state.cursor = null;
      state.complete = false; state.limited = false; state.generation++; this.dirty = true;
    }
    const old = state.records.get(notice.id);
    if (!old || old.sync_identity !== notice.sync_identity || notice.sync_revision >= old.sync_revision) {
      state.records.set(notice.id, notice);
      if (!old || old.sync_identity !== notice.sync_identity || old.sync_revision !== notice.sync_revision) this.dirty = true;
    }
  }
  enforceLimits() {
    const records = []; let size = 0;
    for (const state of this.states.values()) for (const notice of state.records.values()) {
      const length = bytes(notice); size += length; records.push({ state, notice, length });
    }
    if (records.length <= this.maxRecords && size <= this.maxBytes) return;
    // Prefer pending/user-visible matters over settled history, but never claim
    // a capacity-limited cache is a complete copy of the project history.
    records.sort((a, b) => Number(matches(a.notice, 'open') || matches(a.notice, 'unread'))
      - Number(matches(b.notice, 'open') || matches(b.notice, 'unread'))
      || compareKey([a.notice.created_at,a.state.id,a.notice.id,a.notice.sync_identity],
        [b.notice.created_at,b.state.id,b.notice.id,b.notice.sync_identity]));
    let count = records.length;
    for (const { state, notice, length } of records) {
      if (count <= this.maxRecords && size <= this.maxBytes) break;
      state.records.delete(notice.id); state.limited = true; state.complete = false; this.dirty = true;
      state.error = '收件箱缓存达到容量上限；请在来源项目查看完整历史。'; count--; size -= length;
    }
  }
  async refreshProject(row) {
    const state = this.state(row);
    if (state.retry_at > this.now()) return;
    try {
      const { client } = await this.source(row.id);
      for (let page = 0; page < this.pages; page++) {
        const generation = state.generation;
        const model = await this.request(client, 'notice.sync', { cursor: state.cursor, limit: this.pageSize });
        this.assertOpen();
        check(isPlainObject(model) && model.version === 1 && model.project === row.project && HEX.test(model.epoch)
          && typeof model.reset === 'boolean' && typeof model.has_more === 'boolean'
          && typeof model.cursor === 'string' && model.cursor.length <= 1024 && Array.isArray(model.changes)
          && model.changes.length <= this.pageSize, 'invalid Notice synchronization response');
        const changes = model.changes.map(change => {
          check(isPlainObject(change) && safeId(change.id) && HEX.test(change.identity) && typeof change.deleted === 'boolean', 'invalid Notice change');
          const notice = change.deleted ? null : noticeModel(change.notice);
          check(!notice || (notice.id === change.id && notice.sync_identity === change.identity && notice.sync_epoch === model.epoch), 'Notice synchronization identity mismatch');
          return { ...change, notice };
        });
        check((await this.entries()).some(entry => entry.id === row.id), '来源项目已移除或不再允许访问');
        if (state.generation !== generation || this.states.get(row.id) !== state) return;
        if (model.reset || state.epoch !== model.epoch) {
          state.records.clear(); state.epoch = model.epoch; state.complete = false; state.limited = false; this.dirty = true;
        }
        for (const change of changes) {
          if (change.deleted) {
            if (state.records.get(change.id)?.sync_identity === change.identity) { state.records.delete(change.id); this.dirty = true; }
          } else this.applyNotice(state, change.notice);
        }
        if (state.cursor !== model.cursor || state.complete !== (!model.has_more && !state.limited)) this.dirty = true;
        state.cursor = model.cursor; state.online = true; state.checked_at = new Date(this.now()).toISOString();
        state.complete = !model.has_more && !state.limited;
        state.error = state.limited ? '收件箱缓存达到容量上限；请在来源项目查看完整历史。' : null; state.retry_at = 0;
        if (model.reset || changes.length) this.enforceLimits();
        if (!model.has_more) break;
      }
    } catch (error) {
      if (this.closed) return;
      state.online = false; state.retry_at = this.now() + this.backoff;
      state.error = error.code === -32601 ? '来源后台不支持 Notice 同步；请更新该项目后台。'
        : '来源项目不可达或读取未完成；仅显示上次确认的记录。';
    }
  }
  async refresh() {
    this.assertOpen();
    if (this.inflight) return this.inflight;
    const work = (async () => {
      const entries = await this.entries(); let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (!this.closed && next < entries.length) await this.refreshProject(entries[next++]);
      }));
      if (!this.closed) { await this.entries(); this.persist(); }
    })();
    this.inflight = work;
    try { await work; } finally { if (this.inflight === work) this.inflight = null; }
  }
  item(row, notice, state = this.state(row)) {
    return { project_id: row.id, project_name: row.name, project: row.project, notice,
      online: state.online, checked_at: state.checked_at };
  }
  async list({ status = 'all', before = null, limit = 30 } = {}) {
    check(STATUS.has(status), 'invalid inbox status');
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be 1..100');
    const afterKey = before === null ? null : decodeCursor(before, status);
    await this.refresh();
    const entries = await this.entries(), items = [], projects = [];
    for (const row of entries) {
      const state = this.state(row);
      projects.push({ id: row.id, name: row.name, online: state.online, checked_at: state.checked_at,
        error: state.error, complete: state.complete && !state.limited });
      for (const notice of state.records.values()) {
        const item = this.item(row, notice, state);
        if (matches(notice, status) && (!afterKey || compareKey(keyFor(item), afterKey) < 0)) items.push(item);
      }
    }
    items.sort((a, b) => -compareKey(keyFor(a), keyFor(b)));
    const page = []; let size = 0;
    for (const item of items.slice(0, limit)) {
      const length = bytes(item);
      if (page.length && size + length > RESPONSE_LIMIT) break;
      check(length <= RESPONSE_LIMIT, 'Notice record exceeds inbox response limit');
      page.push(item); size += length;
    }
    return { version: 1, items: page, cursor: page.length ? encodeCursor(status, page.at(-1)) : null,
      has_more: items.length > page.length, complete: projects.every(row => row.online && row.complete), projects,
      ...(this.cacheError ? { cache_error: this.cacheError } : {}) };
  }
  async get(projectId, noticeId) {
    check(typeof projectId === 'string' && /^[a-f0-9]{16}$/.test(projectId), 'invalid source project');
    const number = id(noticeId); check(number < Number.MAX_SAFE_INTEGER, 'Notice id exceeds supported range');
    const row = (await this.entries()).find(entry => entry.id === projectId); check(row, '未知或无权访问的来源项目');
    await this.refreshProject(row);
    const state = this.state(row);
    if (!state.online) {
      const notice = state.records.get(number); check(notice, '来源离线，且没有这条事项的缓存');
      return this.item(row, notice, state);
    }
    try {
      const { client } = await this.source(projectId);
      const result = await this.request(client, 'notice.page', { before: number + 1, limit: 1, status: 'all' });
      this.assertOpen();
      check((await this.entries()).some(entry => entry.id === row.id), '来源项目已移除或不再允许访问');
      const value = result?.notices?.find(notice => notice.id === number);
      if (!value) { state.records.delete(number); state.generation++; this.dirty = true; this.persist(); throw new Error('这条事项已删除或不存在'); }
      const notice = noticeModel(value);
      this.applyNotice(state, notice); state.generation++; state.checked_at = new Date(this.now()).toISOString();
      this.enforceLimits(); this.persist(); return this.item(row, notice, state);
    } catch (error) {
      // Missing records and malformed responses must not fall back to old cached content.
      state.online = false; state.retry_at = this.now() + this.backoff;
      state.error = '来源项目读取未完成；请刷新核对当前记录。';
      throw error;
    }
  }
  async action(params) {
    check(isPlainObject(params) && Object.keys(params).every(key => ['project_id','id','method','answer','expected_identity'].includes(key))
      && METHODS.has(params.method) && typeof params.project_id === 'string' && /^[a-f0-9]{16}$/.test(params.project_id), 'invalid inbox action');
    check(params.method === 'notice.answer' ? Object.hasOwn(params, 'answer') : !Object.hasOwn(params, 'answer'), 'invalid inbox action answer');
    check(params.expected_identity === undefined || (typeof params.expected_identity === 'string' && HEX.test(params.expected_identity)), 'invalid Notice record identity');
    const number = id(params.id); check(number < Number.MAX_SAFE_INTEGER, 'Notice id exceeds supported range');
    const { row, client } = await this.source(params.project_id);
    const state = this.state(row);
    const summary = await this.request(client, 'system.summary', {});
    check(summary?.project === row.project, '来源后台项目身份不符；未提交操作');
    // A current read establishes record identity and online availability; it does
    // not retry a mutation or use a cache as authorization to act offline.
    const before = await this.request(client, 'notice.page', { before: number + 1, limit: 1, status: 'all' });
    check(before?.notices?.some(notice => notice.id === number), '这条事项已删除或不存在');
    const original = noticeModel(before.notices.find(notice => notice.id === number));
    check(params.expected_identity === undefined || params.expected_identity === original.sync_identity, '这条事项已变化或被删除，请重新读取再处理');
    check((await this.entries()).some(entry => entry.id === row.id), '来源项目已移除或不再允许访问');
    const receipt = await this.request(client, params.method,
      { id: number, expected_identity: original.sync_identity,
        ...(params.method === 'notice.answer' ? { answer: params.answer } : {}) }, true);
    this.assertOpen();
    check((await this.entries()).some(entry => entry.id === row.id), '来源项目已移除；已提交动作请在来源项目核对');
    const notice = noticeModel(receipt);
    check(notice.id === number && notice.sync_identity === original.sync_identity && notice.sync_epoch === original.sync_epoch,
      '来源记录身份不符；提交结果请在来源项目核对');
    this.applyNotice(state, notice); state.generation++; state.online = true; state.error = null; state.retry_at = 0;
    state.checked_at = new Date(this.now()).toISOString(); this.enforceLimits(); this.persist();
    return this.item(row, notice, state);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
  }
}
