import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { AgentPackages } from '../../src/agent/packages.js';
import { fixture } from '../helpers.js';

test('Project exposes Lush Pi package management through the agent-packages mixin', async () => {
  const f = fixture();
  try {
    const calls = [];
    const dir = path.join(f.config.home, 'pi');
    f.project.agentPackageManager = new AgentPackages(f.config, { run: async options => {
      calls.push(options);
      if (options.args[0] === 'install') {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: ['npm:@scope/tools@1.0.0'] }), { mode: 0o600 });
        return 'Installed npm:@scope/tools@1.0.0';
      }
      return ['User packages:', '  npm:@scope/tools@1.0.0'].join('\n');
    } });

    expect(await f.project.agentPackages()).toMatchObject({ version: 1, packages: [] });
    const installed = await f.project.installAgentPackage('npm:@scope/tools@1.0.0');
    expect(installed).toMatchObject({ version: 1, action: 'install' });
    expect(calls[0]).toMatchObject({ command: 'pi', args: ['install', 'npm:@scope/tools@1.0.0', '--no-approve'], cwd: f.config.project });
    expect(calls[0].env.PI_CODING_AGENT_DIR).toBe(dir);
    const [record] = installed.packages;
    expect(record).toMatchObject({ kind: 'npm', requested: '1.0.0', installed: false });

    const removed = await f.project.removeAgentPackage(record.id);
    expect(removed.action).toBe('remove');
    expect(calls.find(call => call.args[0] === 'remove').args).toEqual(['remove', 'npm:@scope/tools@1.0.0', '--no-approve']);

    const updated = await f.project.updateAgentPackage(record.id);
    expect(updated.action).toBe('update');
    expect(calls.find(call => call.args[0] === 'update').args).toEqual(['update', 'npm:@scope/tools@1.0.0', '--no-approve']);

    await expect(f.project.removeAgentPackage('missing')).rejects.toThrow('invalid package id');
    expect(calls.filter(call => call.args[0] === 'remove')).toHaveLength(1);
  } finally { await f.close(); }
});

test('package mutations respect the clear/delete gate while read-only list stays available', async () => {
  const f = fixture();
  try {
    f.project.agentPackageManager = new AgentPackages(f.config, { run: async () => 'User packages:' });
    f.project.clearing = true;
    await expect(f.project.installAgentPackage('npm:@scope/tools@1.0.0')).rejects.toThrow('clear is in progress');
    expect(await f.project.agentPackages()).toMatchObject({ version: 1, packages: [] });
    f.project.clearing = false;
    f.project.workerDeleteIds = new Set([1]);
    await expect(f.project.removeAgentPackage('pkg-0000000000000000')).rejects.toThrow('deletion is in progress');
    f.project.workerDeleteIds = undefined;
    await expect(f.project.updateAgentPackage('bad-id')).rejects.toThrow('invalid package id');
  } finally { await f.close(); }
});
