import { test, expect } from 'bun:test';
import { isLushWebCommand, parsePidList, parseSsPids, stopStaleWeb, stopWebPids } from '../../src/ui/web/control.js';

// 停旧 Web 是一段会杀进程的代码：杀错对象比停不掉更糟。这里固定住两件事——
// 「什么样的命令行才算 Lush Web」，以及「先 SIGTERM、超时才 SIGKILL」的顺序。

test('只把 Lush Web 的命令行当成自己人', () => {
  expect(isLushWebCommand('/nix/store/x-bun/bin/bun ./scripts/ops.js web 4318 --project /tmp/a')).toBe(true);
  expect(isLushWebCommand('bun run web 4318 --project /tmp/a')).toBe(true);
  // web-restart 停完就在同一个进程里当监听者，命令行留着 -restart：下一次重启必须认得出它
  expect(isLushWebCommand('bun ./scripts/ops.js web-restart 4318 --project /tmp/a')).toBe(true);
  expect(isLushWebCommand('/nix/store/x-bun/bin/bun run web-restart 4318')).toBe(true);
  expect(isLushWebCommand('/usr/local/bin/bun /Users/x/lush/bin/lush-web 4318')).toBe(true);
  expect(isLushWebCommand('node src/ui/web/server.js')).toBe(true);
  // 名字里带 web、但不是 Web UI 的：一个都不能杀
  expect(isLushWebCommand('bun ./scripts/ops.js webpack')).toBe(false);
  expect(isLushWebCommand('bun ./scripts/ops.js web-restart-helper')).toBe(false);
  expect(isLushWebCommand('python3 -m http.server 4318')).toBe(false);
  expect(isLushWebCommand('node /srv/app/server.js')).toBe(false);
  expect(isLushWebCommand('cat /tmp/lush-web')).toBe(false);
  expect(isLushWebCommand('')).toBe(false);
  expect(isLushWebCommand(undefined)).toBe(false);
});

test('解析 lsof -t 与 ss -ltnp 的 pid', () => {
  expect(parsePidList('123\n456\n123\n')).toEqual([123, 456]);
  expect(parsePidList('')).toEqual([]);
  expect(parsePidList('COMMAND PID\nbun 42')).toEqual([]);   // 只认纯数字行：别的行不是 pid
  const ss = 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 0.0.0.0:4318 0.0.0.0:* users:(("bun",pid=123,fd=18))\nLISTEN 0 511 [::]:4318 [::]:* users:(("bun",pid=123,fd=19))\nLISTEN 0 511 0.0.0.0:4399 0.0.0.0:* users:(("node",pid=77,fd=21))';
  expect(parseSsPids(ss)).toEqual([123, 77]);
  expect(parseSsPids('')).toEqual([]);
});

test('不是 Lush Web 的 pid 只报告不杀', async () => {
  const killed = [];
  const result = await stopWebPids([42], {
    alive: () => true, commandOf: () => 'python3 -m http.server 4318',
    kill: (pid, signal) => killed.push(`${pid}:${signal}`), sleep: async () => {},
  });
  expect(killed).toEqual([]);
  expect(result.stopped).toEqual([]);
  expect(result.reason).toBe('not-lush-web');
  expect(result.refused).toEqual([{ pid: 42, command: 'python3 -m http.server 4318' }]);
});

test('SIGTERM 就退出的旧 Web：只发一次信号', async () => {
  const killed = [];
  let alive = true;
  const result = await stopWebPids([11], {
    alive: () => alive, commandOf: () => 'bun ./scripts/ops.js web 4318',
    kill: (pid, signal) => { killed.push(`${pid}:${signal}`); alive = false; }, sleep: async () => {},
  });
  expect(killed).toEqual(['11:SIGTERM']);
  expect(result).toEqual({ stopped: [11], refused: [], stuck: [], reason: 'stopped' });
});

test('SIGTERM 不奏效才升级到 SIGKILL，杀不掉如实报告', async () => {
  const killed = [];
  const alive = new Set([7, 8]);
  const result = await stopWebPids([7, 8], {
    alive: pid => alive.has(pid), commandOf: () => 'bun /Users/x/lush/bin/lush-web',
    kill: (pid, signal) => { killed.push(`${pid}:${signal}`); if (signal === 'SIGKILL' && pid === 7) alive.delete(pid); },
    sleep: async () => {}, timeoutMs: 20, graceMs: 20,
  });
  expect(killed).toEqual(['7:SIGTERM', '8:SIGTERM', '7:SIGKILL', '8:SIGKILL']);
  expect(result.stopped).toEqual([7]);
  expect(result.stuck).toEqual([8]);
  expect(result.reason).toBe('stuck');
});

test('已经不在的 pid 不碰，端口本来就空时报空', async () => {
  const killed = [];
  const result = await stopWebPids([3], { alive: () => false, kill: (pid, signal) => killed.push(`${pid}:${signal}`) });
  expect(killed).toEqual([]);
  expect(result).toEqual({ stopped: [], refused: [], stuck: [], reason: 'free' });
});

test('停完再确认端口空出来，而不是杀完就走', async () => {
  const none = () => [];
  const result = await stopStaleWeb(4318, {
    pids: [9], alive: () => false, kill: () => {}, sleep: async () => {}, listeners: none,
  });
  expect(result.free).toBe(true);
  expect(result.reason).toBe('free');
  // 停不掉时（端口上仍是别人）如实说没腾出来
  const result2 = await stopStaleWeb(4318, {
    pids: [9], alive: () => true, commandOf: () => 'python3 -m http.server', kill: () => {}, sleep: async () => {},
    timeoutMs: 10, listeners: () => [9],
  });
  expect(result2.free).toBe(false);
  expect(result2.refused.length).toBe(1);
  // 杀了但父进程还没回收（僵尸、端口已空）：如实报 stuck，但也如实说端口空了
  const zombie = await stopStaleWeb(4318, {
    pids: [12], alive: () => true, commandOf: () => 'bun ./scripts/ops.js web 4318', kill: () => {},
    sleep: async () => {}, timeoutMs: 10, graceMs: 10, listeners: none,
  });
  expect(zombie.stuck).toEqual([12]);
  expect(zombie.free).toBe(true);
  expect(zombie.reason).toBe('stuck');
});
