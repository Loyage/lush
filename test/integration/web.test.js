import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { temp } from '../helpers.js';
import { freePort, webProcess, waitForWeb } from './harness.js';

// 「文档打开失败」的真身：Web 进程自己活到被杀为止，不会跟着代码换版本。这里用真的进程量一次——
// web-restart 把端口上那个旧 Web 停掉，新起的那个立刻能答页面。
test('web-restart 把端口上的旧 Web 换成新代码，连着重启也认得自己', async () => {
  const root = temp();
  const port = freePort();
  const children = [];
  const spawn = command => { const child = webProcess(root, port, command); children.push(child); return child; };
  try {
    const first = spawn('web');
    await waitForWeb(port);
    const second = spawn('web-restart');
    // 旧的先走：被 SIGTERM 结束，所以 exitCode 为 null、signalCode 有值
    expect(await first.exited).toBe(143);
    expect(first.signalCode).toBe('SIGTERM');
    await waitForWeb(port);                 // 端口重新答上：新的已经在服务
    expect(second.exitCode).toBeNull();
    // 第二次重启：新进程的命令行是 `ops.js web-restart`，也必须被认成自己人
    const third = spawn('web-restart');
    expect(await second.exited).toBe(143);
    await waitForWeb(port);
    expect(third.exitCode).toBeNull();
  } finally {
    for (const child of children) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);

// 直接再起一个 web 只会撞端口；报错里必须给出这条命令，而不是让用户对着
// "Is port 4318 in use?" 猜是哪个进程、该怎么办。
test('端口被已有的 Web 占着时，web 的报错直接指向 web-restart', async () => {
  const root = temp();
  const port = freePort();
  let served = null, clash = null;
  try {
    served = webProcess(root, port);
    await waitForWeb(port);
    clash = webProcess(root, port);
    const stderr = await new Response(clash.stderr).text();
    await clash.exited;
    expect(clash.exitCode).toBe(1);
    expect(stderr).toContain(`web-restart ${port}`);
  } finally {
    served?.kill(); clash?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
