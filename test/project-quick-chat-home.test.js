import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectHost } from '../src/host/project-host.js';
import { projectRouteId, writeLauncherState, removeLauncherProject } from '../src/host/registry.js';
import { temp, env } from './helpers.js';

test('chatHome resolves only registered canonical projects without directory creation or daemon attachment', () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }), calls = [];
  const projects = ['a', 'b'].map(name => { const p = path.join(root, name); fs.mkdirSync(p); writeLauncherState(p, environment); return p; });
  const host = createProjectHost(null, { env: environment,
    attachProject: () => { calls.push('attach'); throw new Error('offline'); },
    openProject: () => { calls.push('start'); throw new Error('offline'); } });
  try {
    for (const project of projects) {
      expect(host.chatHome(projectRouteId(project))).toBe(path.join(project, '.lush', 'quick-chat'));
      expect(fs.existsSync(path.join(project, '.lush'))).toBe(false);
    }
    expect(() => host.chatHome()).toThrow('项目身份');
    expect(() => host.chatHome('ffffffffffffffff')).toThrow('未知');
    removeLauncherProject(projects[0], environment);
    expect(() => host.chatHome(projectRouteId(projects[0]))).toThrow('未知');
    fs.symlinkSync(projects[0], path.join(projects[1], '.lush'));
    expect(() => host.chatHome(projectRouteId(projects[1]))).toThrow('不安全');
    expect(calls).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bound Host chatHome never falls back from a foreign identity and public allowlists exclude other registered projects', () => {
  const root = temp(), environment = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') });
  const projects = ['a', 'b'].map(name => { const p = path.join(root, name); fs.mkdirSync(p); writeLauncherState(p, environment); return p; });
  try {
    const bound = createProjectHost({ project: projects[0] }, { env: environment });
    expect(bound.chatHome()).toBe(path.join(projects[0], '.lush', 'quick-chat'));
    expect(() => bound.chatHome(projectRouteId(projects[1]))).toThrow('未知');
    const restricted = createProjectHost(null, { env: environment, allowedProjects: [projects[0]] });
    expect(restricted.chatHome(projectRouteId(projects[0]))).toBe(bound.chatHome());
    expect(() => restricted.chatHome(projectRouteId(projects[1]))).toThrow('未知');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
