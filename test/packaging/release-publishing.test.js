import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-remote-payload.yml'), 'utf8');

test('payload publishing only builds official tags and verifies the same tagged checkout and run', () => {
  expect(workflow).toContain('push:\n    tags:');
  expect(workflow).toContain("'v[0-9]*.[0-9]*.[0-9]*'");
  expect(workflow).toContain("'!v*-*'"); expect(workflow).toContain("'!v*\\+*'");
  for (const trigger of ['workflow_run:', 'workflow_dispatch:', 'pull_request:', 'branches:']) expect(workflow).not.toContain(trigger);
  expect(workflow).toContain("if: github.repository == 'Loyage/lush'");
  expect(workflow).toContain('fetch-depth: 0');
  expect(workflow).toContain('git merge-base --is-ancestor HEAD origin/main');
  expect(workflow).toContain('needs: validate\n    uses: ./.github/workflows/remote-payload.yml');
  expect(workflow).toContain('publish:\n    needs: native');
  expect(workflow.match(/ref: \$\{\{ github.sha \}\}/g)).toHaveLength(2);
  expect(workflow).toContain('run-id: ${{ github.run_id }}');
  expect(workflow).toContain('name: lush-remote-payload');
  // Only the dependent publishing job can write Releases; validation/builds remain read-only.
  expect(workflow.indexOf('contents: write')).toBeGreaterThan(workflow.indexOf('publish:\n'));
  expect(workflow.match(/contents: write/g)).toHaveLength(1);
  expect(workflow.indexOf('verifyDesktopRemotePayload(process.cwd()')).toBeLessThan(workflow.indexOf('gh release create'));
  expect(workflow).toContain('"payload-v"+m.lush_version+"-"+m.fingerprint');
  expect(workflow).toContain('--target "$SOURCE_COMMIT"'); expect(workflow).toContain('--prerelease --latest=false');
  expect(workflow).toContain('gh release download "$tag"');
  expect(workflow).toContain('verifyDesktopRemotePayload(process.cwd(), process.env.PAYLOAD_DIRECTORY)');
  expect(workflow).not.toContain('--clobber'); expect(workflow).not.toContain('gh release delete');
  expect(workflow).not.toContain('secrets.');
  for (const name of ['remote-payload.yml', 'windows-desktop.yml', 'macos-desktop.yml']) {
    const readonly = fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
    expect(readonly).not.toContain('contents: write'); expect(readonly).not.toContain('gh release create');
  }
  const build = fs.readFileSync(path.join(ROOT, '.github/workflows/remote-payload.yml'), 'utf8');
  expect(build).toContain('workflow_dispatch:'); expect(build).toContain('workflow_call:');
  expect(build).toContain('branches: [main]'); expect(build).toContain('pull_request:');
});

test('the actual CI tag guard rejects prereleases, malformed tags and package-version mismatches', () => {
  const code = workflow.match(/bun --eval '(const tag=process.env.RELEASE_TAG;[^\n]+)'/)[1];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-release-tag-')));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    for (const tag of ['v0.2.0', 'v0.2.1', 'v0.2.0-rc.1', 'v0.2.0+build', 'v00.2.0', 'v0.02.0', 'v0.2.00',
      'v0.2', '0.2.0', 'v0.2.0/evil', 'payload-v0.2.0-0123456789abcdef']) {
      const result = spawnSync(process.execPath, ['--eval', code], { cwd: root, env: { ...process.env, RELEASE_TAG: tag }, encoding: 'utf8' });
      expect(result.status, tag).toBe(tag === 'v0.2.0' ? 0 : 1);
      if (tag !== 'v0.2.0') expect(result.stderr).toContain('Official release tag');
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0-rc.1' }));
    expect(spawnSync(process.execPath, ['--eval', code], { cwd: root, env: { ...process.env, RELEASE_TAG: 'v0.2.0-rc.1' } }).status).toBe(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
