import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp } from '../helpers.js';
import { cli, freePort, httpStatus, waitForWeb } from './harness.js';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Web 是后台服务：命令立刻返回，端口随后答上。这里用真的进程量一遍——重复启动不换进程，
// 换代码（web-restart）真的把旧进程换成新的，web-stop 之后端口不再答话。
test('web 后台起：重复启动幂等、web-restart 换进程、web-stop 收尾', async () => {
  const root = temp();
  const port = freePort();
  try {
    const first = await cli(root, ['web', String(port)]);
    expect(first).toMatchObject({ port, running: true, already_running: false, code_match: true, listeners_known: true });
    expect(first.pid).toBeGreaterThan(0);
    expect(first.log).toBe(`${root}/.lush/web.log`);
    expect(first.current_code.fingerprint).toBe(first.web_code.fingerprint);
    expect(first.identities).toEqual({ current: first.current_code, web: first.web_code });
    expect(first.update_hint).toBeNull();
    await waitForWeb(port);                       // 命令返回时页面就该能打开

    // 再跑一次：端口上是自己人，如实报告“已在运行”，不再 spawn 第二个
    const again = await cli(root, ['web', String(port)]);
    expect(again.already_running).toBe(true);
    expect(again.pid).toBe(first.pid);
    expect(await httpStatus(port)).toBe(200);

    const status = await cli(root, ['web-status', String(port)]);
    expect(status).toMatchObject({ port, running: true, pid: first.pid, code_match: true });
    expect(status.web_code).toMatchObject({ pid: first.pid, fingerprint: status.current_code.fingerprint });

    // 状态文件中的 Web 身份与磁盘代码不一致时，只给准确的项目/端口更新提示，不自动换进程。
    const stateFile = `${root}/.lush/web.state.json`;
    const staleState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...staleState, fingerprint: 'stale-code' }));
    const stale = await cli(root, ['web-status', String(port)]);
    expect(stale).toMatchObject({ pid: first.pid, code_match: false });
    expect(stale.current_code.fingerprint).not.toBe(stale.web_code.fingerprint);
    expect(stale.update_hint).toMatchObject({ process: 'web', project: root, pid: first.pid,
      command: ['bun', 'run', 'web-restart', String(port), '--project', root] });
    expect(alive(first.pid)).toBe(true);

    // 换代码的正路：停掉跑着旧代码的那个进程，再按当前代码起一个新的
    const restarted = await cli(root, ['web-restart', String(port)]);
    expect(restarted.stopped).toEqual([first.pid]);
    expect(restarted.pid).not.toBe(first.pid);
    expect(restarted.code_match).toBe(true);
    expect(alive(first.pid)).toBe(false);
    await waitForWeb(port);

    const stopped = await cli(root, ['web-stop', String(port)]);
    expect(stopped.stopped).toEqual([restarted.pid]);
    await waitForWeb(port, false);
    expect(alive(restarted.pid)).toBe(false);
    expect((await cli(root, ['web-status', String(port)])).running).toBe(false);
  } finally {
    await cli(root, ['web-stop', String(port)]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);

// 端口上是别人的程序（命令行不是 Lush Web）：起和停都不许碰它，只把占用者原样报出来。
test('端口被别的进程占着时既不起也不停：只报告，不改动它', async () => {
  const root = temp();
  const port = freePort();
  const squatter = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('mine') });
  try {
    await expect(cli(root, ['web', String(port)])).rejects.toThrow(/没有动它/);
    await expect(cli(root, ['web-stop', String(port)])).rejects.toThrow(/没有动它/);
    expect(await httpStatus(port)).toBe(200);                  // 占用者一直在服务
  } finally {
    squatter.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
