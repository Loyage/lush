import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { QuickExplanationSettings, DEFAULT_EXPLANATION_PROMPT } from '../src/core/quick-explanation.js';

const file = f => path.join(f.config.home, 'quick-explanation.json');
test('explanation settings are project-local, partial, defaulted and atomically owner-only', async () => {
  const a = fixture(), b = fixture();
  try {
    const settings = new QuickExplanationSettings(a.config);
    expect(settings.read()).toEqual({ connection_id: null, model: '', prompt: DEFAULT_EXPLANATION_PROMPT });
    settings.save(settings.preview({ connection_id: 'conn-one', model: 'vendor/model', prompt: '中文\n说明' }));
    expect(fs.statSync(file(a)).mode & 0o777).toBe(0o600);
    expect(settings.preview({ prompt: null })).toEqual({ connection_id: 'conn-one', model: 'vendor/model', prompt: DEFAULT_EXPLANATION_PROMPT });
    expect(settings.preview({ connection_id: null }).model).toBe('vendor/model');
    expect(new QuickExplanationSettings(b.config).read().model).toBe('');
    const before = fs.readFileSync(file(a), 'utf8');
    for (const patch of [{ unknown: true }, { model: {} }, { connection_id: '../secret' }, { prompt: 'x'.repeat(8193) }])
      expect(() => settings.preview(patch)).toThrow();
    expect(fs.readFileSync(file(a), 'utf8')).toBe(before);
  } finally { await a.close(); await b.close(); }
});

test('explanation settings reject symlinks, hardlinks, bad modes, malformed and oversized private files', async () => {
  const f = fixture();
  try {
    const settings = new QuickExplanationSettings(f.config);
    const target = path.join(f.root, 'outside');
    fs.writeFileSync(target, JSON.stringify({ version: 1 }), { mode: 0o600 });
    fs.symlinkSync(target, file(f)); expect(() => settings.read()).toThrow('私有文件');
    expect(() => settings.save({})).toThrow('私有文件'); fs.unlinkSync(file(f));
    fs.linkSync(target, file(f)); expect(() => settings.read()).toThrow('私有文件'); fs.unlinkSync(file(f));
    fs.writeFileSync(file(f), '{', { mode: 0o600 }); expect(() => settings.read()).toThrow('私有文件');
    fs.writeFileSync(file(f), JSON.stringify({ version: 1, api_key: 'do-not-save' })); expect(() => settings.read()).toThrow('私有文件');
    fs.writeFileSync(file(f), JSON.stringify({ version: 1 })); fs.chmodSync(file(f), 0o644); expect(() => settings.read()).toThrow('私有文件');
    fs.chmodSync(file(f), 0o600); fs.writeFileSync(file(f), 'x'.repeat(65537)); expect(() => settings.read()).toThrow('私有文件');
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify({ version: 1 }));
  } finally { await f.close(); }
});
