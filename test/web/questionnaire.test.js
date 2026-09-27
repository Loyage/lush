import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';
import { previewResponse, PREVIEW_CSP } from '../../src/ui/web/notice-preview.js';

const malicious = `<style>.card{color:teal;background:url(https://evil.invalid/x)}@import 'https://evil.invalid/css';</style>
<div class="card" onclick="alert(1)">Sample</div><script>fetch('/api/action')</script>
<meta http-equiv="refresh" content="0;url=https://evil.invalid/"><base href="https://evil.invalid/">
<a href="https://evil.invalid/" target="_top">escape</a><iframe src="/api/snapshot"></iframe>
<svg><a href="https://evil.invalid/">SVG</a></svg><form action="/api/action"><button>Send</button></form>
<img src="https://evil.invalid/a" srcset="https://evil.invalid/b 2x" onerror="alert(1)">
<img src="data:image/svg+xml;base64,PHN2Zz4="><img alt="pixel" src="data:image/png;base64,aGVsbG8=">
<input type="image" src="https://evil.invalid/c" formaction="/api/action"><button formaction="/api/action">Example</button>`;
const form = html => [{ header: 'Layout', question: 'Choose?', options: [
  { label: 'A', description: 'First', previewHtml: html }, { label: 'B', description: 'Second' },
] }];

test('HTML previews retain static styling but remove scripts, navigation and active content', async () => {
  const response = previewResponse(malicious);
  const html = await response.text();
  expect(response.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
  expect(PREVIEW_CSP).toContain("default-src 'none'"); expect(PREVIEW_CSP).toContain("script-src 'none'"); expect(PREVIEW_CSP).toContain('sandbox;');
  expect(html).toContain('<style>'); expect(html).toContain('class="card"'); expect(html).toContain('Sample');
  for (const value of ['<script', 'onclick', 'onerror', '<meta', '<base', '<iframe', '<svg', '<form', 'formaction', 'srcset=', 'target=', 'src="https:', 'data:image/svg']) expect(html).not.toContain(value);
  expect(html).toContain('data:image/png;base64,'); expect(html).toContain('disabled=""');
});

test('questionnaire HTTP route serves stored previews only, preserves main CSP, and accepts atomic answers', async () => {
  const f = await setup();
  try {
    const task = f.store.create({ role: 'research', goal: 'decision' });
    const n = f.project.notice(task.id, 'Choose', '', 'question', form(malicious));
    const response = await fetch(`${f.url}/api/task/${task.id}/notice/${n.id}/preview/0/0`);
    expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
    expect(await response.text()).not.toContain('<script');
    expect((await fetch(f.url + '/')).headers.get('content-security-policy')).toContain("style-src 'self'");
    expect((await fetch(f.url + '/render-questionnaire.js')).status).toBe(200);
    for (const suffix of [`${n.id}/preview/0/1`, `${n.id}/preview/5/0`, `999/preview/0/0`]) {
      expect((await fetch(`${f.url}/api/task/${task.id}/notice/${suffix}`)).status).toBe(400);
    }
    const action = answer => fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'notice.answer', params: { id: n.id, answer } }) });
    expect((await action('A')).status).toBe(400);
    const accepted = await action({ answers: [{ selected: [0] }] }); expect(accepted.status).toBe(200);
    expect(JSON.parse((await accepted.json()).answer).answers[0].labels).toEqual(['A']);
    expect((await action({ answers: [{ selected: [1] }] })).status).toBe(400);
  } finally { await f.close(); }
});

test('HTML preview routes require the same authentication as the Web UI', async () => {
  const f = await setup({ auth: { username: 'test', password: 'a-long-enough-password' } });
  try {
    const response = await fetch(`${f.url}/api/task/1/notice/1/preview/0/0`);
    expect(response.status).toBe(401);
  } finally { await f.close(); }
});
