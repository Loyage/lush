import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.js';
import { freezeChoiceContext, choiceContextPath, choiceForkPath, choiceDigest, writeChoiceFile, readChoiceFile } from '../src/agent/choice-context.js';

function fixture(entries) {
  const home = temp();
  fs.mkdirSync(path.join(home, 'sessions'));
  const session = path.join(home, 'sessions', 'time_lush-task-7.jsonl');
  const header = { type: 'session', version: 3, id: 'session', parentSession: '/old/session.jsonl' };
  fs.writeFileSync(session, [header, ...entries].map(JSON.stringify).join('\n') + '\n');
  return { home, session, close: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const user = { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'before' } };
const assistant = { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } };

test('freezes only exact ancestor path and independent immutable private copies', () => {
  const f = fixture([user, assistant, { ...user, id: 'late', parentId: 'a', message: { role: 'user', content: 'old answer' } },
    { ...user, id: 'other', parentId: null, message: { role: 'user', content: 'unrelated branch' } }]);
  try {
    const bytes = freezeChoiceContext(f.home, 7, { session: f.session, entry: 'a' });
    expect(bytes.toString()).toContain('thinking');
    expect(bytes.toString()).not.toContain('old answer');
    expect(bytes.toString()).not.toContain('unrelated');
    expect(bytes.toString()).not.toContain('parentSession');
    const saved = choiceContextPath(f.home, 9), copy = choiceForkPath(f.home, 10);
    writeChoiceFile(f.home, saved, bytes); writeChoiceFile(f.home, copy, bytes);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    fs.unlinkSync(saved);
    expect(readChoiceFile(f.home, copy, choiceDigest(bytes))).toEqual(bytes);
    expect(() => writeChoiceFile(f.home, copy, bytes)).toThrow();
    fs.appendFileSync(copy, '{}\n');
    expect(() => readChoiceFile(f.home, copy, choiceDigest(bytes))).toThrow('checkpoint');
  } finally { f.close(); }
});

test('incomplete tool calls, missing ancestry, cycles and unsupported formats fail closed', () => {
  const f = fixture([user, { ...assistant, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash' }] } }]);
  try {
    expect(() => freezeChoiceContext(f.home, 7, { session: f.session, entry: 'a' })).toThrow('tool boundary');
    expect(() => freezeChoiceContext(f.home, 7, { session: f.session, entry: 'absent' })).toThrow('incomplete');
    fs.appendFileSync(f.session, JSON.stringify({ type: 'message', id: 'r', parentId: 'a', message: { role: 'toolResult', toolCallId: 'call', content: [] } }) + '\n');
    expect(freezeChoiceContext(f.home, 7, { session: f.session, entry: 'r' }).toString()).toContain('toolResult');
    fs.appendFileSync(f.session, JSON.stringify({ type: 'custom', id: 'loop', parentId: 'loop' }) + '\n');
    expect(() => freezeChoiceContext(f.home, 7, { session: f.session, entry: 'loop' })).toThrow('cyclic');
  } finally { f.close(); }
});

test('source ownership and symlinks are never followed', () => {
  const f = fixture([user, assistant]);
  try {
    expect(() => freezeChoiceContext(f.home, 8, { session: f.session, entry: 'a' })).toThrow('belong');
    fs.renameSync(f.session, `${f.session}.original`);
    fs.symlinkSync(`${f.session}.original`, f.session);
    expect(() => freezeChoiceContext(f.home, 7, { session: f.session, entry: 'a' })).toThrow('symlink');
  } finally { f.close(); }
});
