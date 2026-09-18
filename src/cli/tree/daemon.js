/** The `daemon` command group: the lifecycle and status of lushd itself. */
export const daemonGroup = {
  summary: 'daemon（lushd）的启动、停止与运行状态',
  cover: [
    '管理后台 daemon 的单实例生命周期：start 幂等启动，stop 中断活动调用、等锁释放后退出。',
    'status 报告 daemon PID、provider、服务数与活动调用数。',
    '不覆盖：服务自身的启停（见 `lush service start|stop|kill`）。',
  ],
  children: {
    start: {
      command: 'daemon',
      summary: '启动 daemon（幂等）',
      cover: [
        'detached 启动 daemon 并等待 RPC ready；已在运行时幂等返回现有 daemon 的状态。',
        '日志写入 `$LUSH_HOME/daemon.log`；启动超时或服务立即退出时报错并指向该日志。',
        '输出包含本次操作的 home、代码目录与指纹（cli.*）：`bun run` 入口与手动运行可能用不同的 LUSH_HOME。',
      ],
      usage: ['lush daemon start'],
      parse: () => ({ action: 'start' }),
    },
    stop: {
      command: 'daemon',
      summary: '停止 daemon 并等待单实例锁释放',
      cover: [
        '发送 system.shutdown，等待锁释放；已停止时幂等。',
        '中断 daemon 中正在进行的 Agent 调用（服务与历史都保留，重启后仍在）。',
        '只作用于本次 CLI 的 LUSH_HOME；输出里的 home 表明停的是哪一份 daemon。',
      ],
      usage: ['lush daemon stop'],
      parse: () => ({ action: 'stop' }),
    },
    restart: {
      command: 'daemon',
      summary: '重启 daemon（stop 后 start，等待新 daemon ready）',
      cover: [
        '先 stop（中断 daemon 中正在进行的 Agent 调用），等单实例锁释放后再 start，返回新 daemon 的状态。',
        'daemon 没在运行时等价于一次 start（was_running=false）。',
        '改代码或提示词后用它让新代码生效：重启只作用于本次 CLI 的 LUSH_HOME；`bun run daemon-restart` 是同一件事。',
        '服务树、Context、消息与调用历史都保留；被中断的调用标记为 interrupted。',
      ],
      usage: ['lush daemon restart'],
      parse: () => ({ action: 'restart' }),
    },
    status: {
      command: 'status',
      method: 'system.status',
      summary: '查看 daemon 与根服务状态',
      cover: [
        '返回 daemon_pid、provider、服务总数、活动调用数等运行状态。',
        '同时报告 daemon 自己的 home、code_dir、fingerprint、started_at，以及 CLI 侧的同样信息（cli.*，其中 cli.code_match 表示两边是否同一份代码）。',
        'daemon 是常驻服务，改完提示词或 CLI 必须重启它才生效：这里用来发现「连的不是同一个 home」或「daemon 跑的是旧代码」。',
        '要求 daemon 正在运行：未启动时失败，这是判断「daemon 是否活着」的入口。',
      ],
      usage: ['lush daemon status'],
      parse: () => ({}),
    },
  },
};
