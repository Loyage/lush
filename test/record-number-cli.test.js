import { test, expect } from 'bun:test';
import { inputNumber, noticeNumber } from '../src/core/record-number.js';
import { print } from '../src/cli/args.js';
import { run as noticeCommand } from '../src/cli/commands/notice.js';

async function capture(fn) {
  const lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { value: await fn(), text: lines.join('\n') }; }
  finally { console.log = original; }
}

test('Notice numbers use only explicit kind, including historical plans and unknown kinds', () => {
  for (const kind of ['question', 'questionnaire', 'plan']) {
    expect(noticeNumber({ id: 17, kind, status: 'answered', title: '纯告知' })).toBe('D17');
  }
  for (const kind of ['info', 'future-kind', undefined, null, '', 'QUESTION', 'toString']) {
    expect(noticeNumber({ id: 17, kind, status: 'open', title: '用户决定' })).toBe('N17');
  }
  expect(inputNumber(19)).toBe('O19');
});

test('human summaries label decisions, info and original Inputs without changing drafts/messages or JSON', async () => {
  const rows = [
    { id: 3, kind: 'question', task_id: 100, title: 'question', status: 'open' },
    { id: 4, kind: 'questionnaire', task_id: 100, title: 'questionnaire', status: 'answered' },
    { id: 5, kind: 'plan', task_id: 100, title: 'legacy', status: 'dismissed' },
    { id: 6, kind: 'info', task_id: 100, title: 'info', status: 'sent' },
    { id: 7, kind: 'future', task_id: 100, title: 'unknown', status: 'open' },
    { id: 8, kind: 'input', content: 'original', status: 'unknown' },
    { id: 9, flow: null, content: 'legacy original' },
    { id: 10, kind: 'draft', content: 'buffered', status: 'draft' },
    { id: 11, task_id: 100, body: 'follow-up' },
    { id: 12, title: 'unrelated', kind: 'artifact' },
  ];
  const snapshot = structuredClone(rows);
  const result = await capture(() => print(rows, false));
  expect(result.text.split('\n').map(line => line.split('\t')[0])).toEqual([
    'D3', 'D4', 'D5', 'N6', 'N7', 'O8', 'O9', '10', '11', '12',
  ]);
  expect(rows).toEqual(snapshot);
  expect(JSON.parse((await capture(() => print(rows, true))).text)).toEqual(snapshot);
});

for (const [verb, args, kind] of [
  ['post', ['title', '--worker', '100'], 'question'],
  ['answer', ['17', 'yes'], 'question'],
  ['dismiss', ['17'], 'questionnaire'],
  ['read', ['17'], 'info'],
]) {
  test(`notice ${verb} labels single human result and keeps JSON/RPC IDs untouched`, async () => {
    const row = { id: 17, kind, task_id: 100, title: 'history #17 stays literal', status: verb === 'read' ? 'sent' : 'answered', body: 'old #17' };
    const calls = [], client = { async request(method, params) { calls.push({ method, params }); return row; } };
    const human = await capture(() => noticeCommand('notice', [verb, ...args], { client, json: false }));
    expect(human.value).toBe(row);
    expect(human.text).toStartWith(`${kind === 'info' ? 'N' : 'D'}17\t`);
    expect(human.text).toContain('history #17 stays literal');
    const machine = await capture(() => noticeCommand('notice', [verb, ...args], { client, json: true }));
    expect(machine.value).toBe(row); expect(machine.text).toBe('');
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe(`notice.${verb}`);
    expect(calls[0].params[verb === 'post' ? 'task' : 'id']).toBe(verb === 'post' ? 100 : 17);
    expect(calls[1]).toEqual(calls[0]);
    expect(row.body).toBe('old #17');
  });
}

test('notice list passes original rows to the common human/JSON printer', async () => {
  const rows = [{ id: 2, task_id: 100, kind: 'info', title: 'known' }];
  const client = { async request(method) { expect(method).toBe('notice.list'); return rows; } };
  const result = await noticeCommand('notice', ['list'], { client, json: false });
  expect(result).toBe(rows);
  expect((await capture(() => print(result, false))).text).toStartWith('N2\t');
});
