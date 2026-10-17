import path from 'node:path';
import fs from 'node:fs';
import { check, id } from '../../core/types.js';
import { workerLabel } from '../../cli/worker-number.js';
import { previewResponse } from './notice-preview.js';
import { PARAMS } from '../../rpc/registry.js';

/** 检验报告是 agent 写的自包含 HTML：只允许内联样式/脚本与 data: 图片，禁止任何外部加载与表单提交。
 *  主页面 CSP 不会作用于这个独立文档，所以这里必须自己收紧。 */
const REPORT_CSP = "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

/** Worker-specific GET adapters; the project route whitelist is checked by the caller. */
export async function workerRead({ url, headers, json }, binding) {
  const client = binding?.client;
  const preview = /^\/api\/worker\/(\d+)\/notice\/(\d+)\/preview\/(\d+)\/(\d+)$/.exec(url.pathname);
  if (preview) {
    const page = await client.request('notice.page', { before: Number(preview[2]) + 1, limit: 1 });
    const notice = page.notices.find(row => row.id === Number(preview[2]) && row.task_id === Number(preview[1]) && row.kind === 'questionnaire');
    check(notice, 'questionnaire not found');
    const html = JSON.parse(notice.body).questions?.[Number(preview[3])]?.options?.[Number(preview[4])]?.previewHtml;
    check(typeof html === 'string', 'HTML preview not found');
    return previewResponse(html, headers);
  }
  const report = /^\/api\/worker\/(\d+)\/report$/.exec(url.pathname);
  if (report) {
    const task = await client.request('worker.inspect', { id: Number(report[1]) });
    if (task.role !== 'verifier') return json({ error: 'not found' }, 404);
    const file = path.join(binding.config.home, 'verify', String(task.id), 'report.html');
    if (!fs.existsSync(file)) return json({ error: `worker ${workerLabel(task)} has no report yet` }, 404);
    const stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file && stat.size <= 8 * 1024 * 1024, 'unsafe report file');
    // 独立顶层文档（新标签打开）：不受主页面 CSP 约束，但仍显式收紧到一个自包含页面。
    return new Response(Bun.file(file), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_CSP } });
  }
  const runsPage = /^\/api\/worker\/(\d+)\/runs-page$/.exec(url.pathname);
  if (runsPage) {
    const params = { id: id(runsPage[1]) };
    for (const [key, value] of url.searchParams) {
      check(PARAMS['worker.runs_page'].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate run query parameter');
      check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'invalid run numeric query parameter');
      params[key] = Number(value);
    }
    const page = await client.request('worker.runs_page', params);
    // Performance reads need clocks/identity, not results, errors, profiles or credentials.
    return json({ cursor: page.cursor, has_more: page.has_more, limit: page.limit,
      items: page.items.map(({ id, task_id, attempt, status, started_at, ended_at }) => ({ id, task_id, attempt, status, started_at, ended_at })) });
  }
  const runSettings = /^\/api\/worker\/(\d+)\/run-settings$/.exec(url.pathname);
  if (runSettings) {
    check(!url.search, 'run settings accept no query parameters');
    return json(await client.request('worker.run_settings', { id: Number(runSettings[1]) }));
  }
  const deletePreview = /^\/api\/worker\/(\d+)\/delete-preview$/.exec(url.pathname);
  if (deletePreview) {
    const query = [...url.searchParams];
    check(query.length === 0 || (query.length === 1 && query[0][0] === 'force' && query[0][1] === 'true'),
      'delete preview accepts only force=true');
    return json(await client.request('worker.delete_preview', { id: Number(deletePreview[1]),
      ...(query.length ? { force: true } : {}) }));
  }
  const codeRead = /^\/api\/worker\/(\d+)\/(code-state|code-tree|code-file)$/.exec(url.pathname);
  if (codeRead) {
    const method = 'worker.' + codeRead[2].replace('-', '_'), params = { id: Number(codeRead[1]) };
    const allowed = codeRead[2] === 'code-state' ? ['scope','after','limit'] : codeRead[2] === 'code-tree'
      ? ['scope','path','query','changed','after','limit','revision'] : ['scope','path','view','side','offset','limit','context','revision'];
    for (const [key, value] of url.searchParams) {
      check(allowed.includes(key) && !(key in params), 'unknown or duplicate code query parameter');
      if (key === 'changed') { check(value === 'true' || value === 'false', 'invalid changed filter'); params[key] = value === 'true'; }
      else params[key] = ['after','limit','offset','context'].includes(key) ? Number(value) : value;
    }
    return json(await client.request(method, params));
  }
  const reading = /^\/api\/worker\/(\d+)\/(transcript-search|transcript-step|transcript-page|transcript-latest|explanations|intros)$/.exec(url.pathname);
  if (reading) {
    const id = Number(reading[1]), q = url.searchParams;
    if (reading[2] === 'intros') return json(await client.request('intro.list', { id, before: q.has('before') ? Number(q.get('before')) : null }));
    if (reading[2] === 'transcript-search') return json(await client.request('worker.transcript_search', {
      id, query: q.get('query') ?? '', kind: q.get('kind') ?? '', tool: q.get('tool') ?? '', errors: q.get('errors') === 'true',
      after: Number(q.get('after') ?? 0), limit: Number(q.get('limit') ?? 50),
    }));
    if (reading[2] === 'transcript-page') return json(await client.request('worker.transcript_page', { id, seq: Number(q.get('seq') ?? 1), offset: Number(q.get('offset') ?? 0) }));
    if (reading[2] === 'transcript-latest') return json(await client.request('worker.transcript_latest', {
      id, after: Number(q.get('after') ?? 0), before: Number(q.get('before') ?? 0), limit: Number(q.get('limit') ?? 100),
    }));
    if (reading[2] === 'transcript-step') return json(await client.request('worker.transcript_step', { id, seq: Number(q.get('seq')), offset: Number(q.get('offset') ?? 0) }));
    return json(await client.request('explanation.list', { id, before: q.has('before') ? Number(q.get('before')) : null }));
  }
  const explanation = /^\/api\/explanation\/(\d+)$/.exec(url.pathname);
  if (explanation) return json(await client.request('explanation.get', { id: Number(explanation[1]) }));
  if (url.pathname === '/api/intro/config') return json(await client.request('intro.config'));
  const intro = /^\/api\/intro\/(\d+)$/.exec(url.pathname);
  if (intro) return json(await client.request('intro.get', { id: Number(intro[1]) }));
  const versions = /^\/api\/worker\/(\d+)\/(version-graph|version-deliveries|version-commit|version-lineage|version-lineage-commit)$/.exec(url.pathname);
  if (versions) {
    const params = { id: id(versions[1]) };
    const method = 'worker.' + versions[2].replaceAll('-', '_');
    const allowed = PARAMS[method].filter(key => key !== 'id');
    for (const [key, value] of url.searchParams) {
      check(allowed.includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate Worker version query parameter');
      if (['delivery','before','limit'].includes(key)) {
        check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), 'invalid Worker version numeric query parameter');
        params[key] = Number(value);
      } else params[key] = value;
    }
    return json(await client.request(method, params));
  }
  const relations = /^\/api\/worker\/(\d+)\/relations$/.exec(url.pathname);
  if (relations) {
    const params = { id: id(relations[1]) };
    for (const [key, value] of url.searchParams) {
      check(['after','limit'].includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate Worker relations query parameter');
      check(/^(0|[1-9]\d*)$/.test(value), 'invalid Worker relations numeric query parameter');
      params[key] = Number(value);
    }
    return json(await client.request('worker.relations', params));
  }
  const progressHistory = /^\/api\/worker\/(\d+)\/progress-history$/.exec(url.pathname);
  if (progressHistory) return json(await client.request('worker.progress_history', {
    id: Number(progressHistory[1]), before: url.searchParams.get('before'),
    limit: url.searchParams.get('limit') ?? 10,
  }));
  const inputReading = /^\/api\/worker\/(\d+)\/(reading-page|reading-record)$/.exec(url.pathname);
  if (inputReading) {
    const method = 'worker.' + inputReading[2].replace('-', '_'), params = { id: Number(inputReading[1]) };
    const allowed = inputReading[2] === 'reading-page' ? ['before_event','before_message','limit','query'] : ['kind','record_id','offset'];
    for (const [key, value] of url.searchParams) {
      check(allowed.includes(key) && !Object.hasOwn(params, key), 'unknown or duplicate reading query parameter');
      if (['query','kind'].includes(key)) params[key] = value;
      else {
        check(/^(0|[1-9]\d*)$/.test(value), 'invalid reading numeric query parameter');
        params[key] = Number(value);
      }
    }
    return json(await client.request(method, params));
  }
  const historyPage = /^\/api\/worker\/(\d+)\/history-page$/.exec(url.pathname);
  if (historyPage) return json(await client.request('worker.history_page', {
    id: Number(historyPage[1]), before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
    limit: Number(url.searchParams.get('limit') ?? 100),
  }));
  const read = /^\/api\/worker\/(\d+)(\/(history|diff|transcript|usage))?$/.exec(url.pathname);
  if (read) {
    const taskId = Number(read[1]);
    if (read[3] === 'history') return json(await client.request('worker.history', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
    if (read[3] === 'diff') return json(await client.request('worker.diff', { id: taskId }));
    if (read[3] === 'usage') return json(await client.request('worker.usage', { id: taskId }));
    if (read[3] === 'transcript') return json(await client.request('worker.transcript', { id: taskId, after: Number(url.searchParams.get('after') ?? 0) }));
    return json(await client.request('worker.inspect', { id: taskId }));
  }
  return null;
}
