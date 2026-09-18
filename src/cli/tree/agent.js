import { next } from '../args.js';
import {
  agentAdd, agentDefault, agentDelete, agentEdit, agentInspect, agentList, agentPath,
} from '../agent.js';

/**
 * The `agent` command group: agent profiles, one configuration file per agent.
 *
 * These are the only commands that do not talk to the daemon: a profile is a
 * plain file under `$LUSH_HOME/agents/`, so the CLI reads and writes it itself
 * and every verb here keeps working while `lushd` is stopped.
 */

const NAME_POSITIONAL = ['NAME', "profile 名，也是文件名 $LUSH_HOME/agents/NAME.json；须匹配 ^[A-Za-z][A-Za-z0-9_-]*$"];

const PLUGIN_OPTIONS = {
  '--no-plugins': {
    arg: null,
    desc: '纯净化（默认）：追加 --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files',
    apply: (r) => { r.plugins = false; },
  },
  '--plugins': {
    arg: null,
    desc: '保留 pi 自己的默认行为（不追加任何 --no-*）；可用 --flag 单独关掉某一项',
    apply: (r) => { r.plugins = true; },
  },
};

const PROFILE_OPTIONS = {
  '--provider': {
    arg: 'NAME',
    desc: '后端：pi（默认，外部子进程）/ openai / mock（内置运行时）',
    apply: (r, v) => { r.provider = v; },
  },
  '--command': {
    arg: 'BIN',
    desc: 'pi 可执行文件；省略时沿用 LUSH_PI_COMMAND，最后回落到 pi',
    // `command` is the parser's own leaf id, so the profile field travels under
    // its own key and is mapped when the profile is built.
    apply: (r, v) => { r.pi_command = v; },
  },
  '--model': {
    arg: 'MODEL',
    desc: '透传给 pi --model',
    apply: (r, v) => { r.model = v; },
  },
  '--pi-provider': {
    arg: 'PROVIDER',
    desc: '透传给 pi --provider',
    apply: (r, v) => { r.pi_provider = v; },
  },
  ...PLUGIN_OPTIONS,
  '--flag': {
    arg: 'FLAG',
    desc: '额外 pi 参数（一个 token，可重复）；追加在插件开关之后',
    apply: (r, v) => { r.flags = [...(r.flags ?? []), v]; },
  },
  '--description': {
    arg: 'TEXT',
    desc: '备注，只用于 list / inspect',
    apply: (r, v) => { r.description = v; },
  },
};

export const agentGroup = {
  summary: 'agent profile：每个 agent 一套配置（provider / 命令 / 模型 / 插件开关）',
  cover: [
    'profile = 「一个进程用哪个 agent、这个 agent 长什么样」：provider（pi / openai / mock）、命令、模型与 pi 插件开关。',
    '每个 profile 是 $LUSH_HOME/agents/<name>.json 一个文件，可手写、可被这里校验；文件名就是 agent 名（没有 name 字段），未知字段一律拒绝。',
    '内置 default：provider pi + 纯净化参数（不加载 extensions / skills / prompt templates / themes / AGENTS.md），永远可用、不可删除；写 $LUSH_HOME/agents/default.json 可逐字段覆盖它。',
    '这些命令只读写 profile 文件，不经过 daemon：daemon 没运行时也能用（这是它和 `lush process ...` 的区别）。daemon 在每次 call 时按 profile 决定后端。',
    '选择优先级：进程显式选择（spawn --agent / 模板 agent 字段）> 环境变量（LUSH_PROVIDER / LUSH_PI_COMMAND / LUSH_PI_PROVIDER / LUSH_PI_MODEL）> 内置 default。',
    '不覆盖：运行期的 agent（TASK.N，用 `lush task agents`）与某个 task 的持久 session（用 `lush task session`）。',
  ],
  notes: [
    '解析是逐字段叠加：profile 声明的字段 > 环境变量 > 内置 fallback；profile 只写它要改的字段即可（例如只写 {"plugins":true} 就沿用环境的 provider / 命令）。',
    'pi 最终 argv 里的开关顺序固定：插件开关（plugins=false 时为上面五个 --no-*），然后是 profile 的 flags，再是 session / 身份参数。',
    'profile 文件 0700 目录、0600 文件，与 $LUSH_HOME 的其他内容一致；daemon 在 call 时读盘，改完无需 restart。',
  ],
  usage: ['lush agent <command> [args]', 'lush agent help [command]'],
  children: {
    list: {
      command: 'agent_list',
      local: (config) => agentList(config),
      summary: '列出全部 agent profile',
      cover: [
        '列出所有 profile（含内置 default）的一行摘要：名称、provider、命令、模型、插件开关、是否默认、来源与文件路径。',
        '来源 builtin 表示只有内置定义（当前就是没有 override 文件的 default）；file 表示该 profile 有文件。',
        '文件写坏了也照样列出来，并在该行标出校验错误，便于定位——`agent list` 是发现手写 profile 写错的地方。',
      ],
      usage: ['lush agent list'],
      parse: () => ({}),
    },
    inspect: {
      command: 'agent_inspect',
      local: (config, args) => agentInspect(config, args),
      summary: '查看一个 profile 的完整配置与它会跑的命令行',
      cover: [
        '给出解析后的全部字段、每个字段来自哪里（文件声明 / 环境变量 / 内置 fallback，见 declared）、来源（builtin / 文件路径）与校验结果。',
        '并给出该 profile 真正会跑的 argv 预览（假 invocation：PROMPT 等用占位符），命令不存在时只报 preview_error，不影响其他信息。',
        '内置运行时的 provider（mock / openai）没有外部命令行，preview 为 null。',
      ],
      usage: ['lush agent inspect NAME'],
      positionals: [NAME_POSITIONAL],
      parse: (args) => ({ name: next(args, 'name') }),
    },
    add: {
      command: 'agent_add',
      local: (config, args) => agentAdd(config, args),
      summary: '写一个 agent profile 文件',
      cover: [
        '把给出的字段写进 $LUSH_HOME/agents/<name>.json；只写明确给出的字段（provider 默认 pi），其余留给环境变量与内置 fallback。',
        '名字必须合法、字段必须合法、默认拒绝覆盖已有文件（--force 才覆盖）。',
        '新增 default 就是写内置 default 的 override 文件；没有 override 文件时直接成功，已有才需要 --force。',
      ],
      notes: [
        '--no-plugins 是默认值：新 profile 默认就是纯净 pi；要恢复 pi 自己的插件行为用 --plugins。',
        '--flag 一次一个 token，可重复；写入文件后按顺序追加在插件开关之后。',
      ],
      usage: [
        'lush agent add NAME [--provider pi|openai|mock] [--command BIN] [--model M] [--pi-provider P]',
        '                   [--no-plugins | --plugins] [--flag F]... [--description D] [--force]',
      ],
      positionals: [NAME_POSITIONAL],
      options: {
        ...PROFILE_OPTIONS,
        '--force': { arg: null, desc: '文件已存在时覆盖', apply: (r) => { r.force = true; } },
      },
      parse: (args) => ({ name: next(args, 'name') }),
    },
    edit: {
      command: 'agent_edit',
      local: (config, args) => agentEdit(config, args),
      summary: '增量修改一个 profile',
      cover: [
        '与 add 同一套 flag，但未给出的字段保持不变：读回文件里已声明的字段，只覆盖这次给出的。',
        'edit default 在没有 override 文件时会创建一个（以内置 default 为基础）；编辑其他不存在的 profile 会报错。',
        '至少给一个选项，否则报用法错误。',
      ],
      notes: [
        '--flag 给定时，flags 整体替换为这次给出的列表（不会累加到旧列表上）。',
      ],
      usage: [
        'lush agent edit NAME [--provider pi|openai|mock] [--command BIN] [--model M] [--pi-provider P]',
        '                    [--no-plugins | --plugins] [--flag F]... [--description D]',
      ],
      positionals: [NAME_POSITIONAL],
      options: { ...PROFILE_OPTIONS },
      parse: (args) => ({ name: next(args, 'name') }),
    },
    delete: {
      command: 'agent_delete',
      local: (config, args) => agentDelete(config, args),
      summary: '删除一个 profile 文件',
      cover: [
        '删除 $LUSH_HOME/agents/<name>.json；文件不存在时报错。',
        'default 拒绝删除：它是保底配置，永远可用（只能 edit 它的 override 文件）。',
      ],
      usage: ['lush agent delete NAME'],
      positionals: [NAME_POSITIONAL],
      parse: (args) => ({ name: next(args, 'name') }),
    },
    default: {
      command: 'agent_default',
      local: (config, args) => agentDefault(config, args),
      summary: '查看 effective 默认 agent，或把某个 profile 设为 default 的 override',
      cover: [
        '不带 NAME：打印当前 effective 默认 agent（内置 default + 环境变量叠加）的完整配置与命令行预览。',
        '带 NAME：把该 profile 自己声明的字段复制进 $LUSH_HOME/agents/default.json，即改变「没有显式选 agent 时」的基线配置。',
        '内置 default 永远存在、不可删除，本命令只写 override 文件；同样不需要 daemon。',
      ],
      notes: [
        '复制的是 profile 文件里声明的字段，不是它叠加环境变量后的结果。',
      ],
      usage: ['lush agent default', 'lush agent default NAME'],
      positionals: [['NAME', '要复制为 default 的 profile 名（省略则只查看当前默认）']],
      parse: (args) => (args.length ? { name: next(args, 'name') } : {}),
    },
    path: {
      command: 'agent_path',
      local: (config) => agentPath(config),
      summary: '打印 profile 目录',
      cover: [
        '打印 profile 目录（$LUSH_HOME/agents）与它所属的 LUSH_HOME，便于直接编辑文件。',
      ],
      usage: ['lush agent path'],
      parse: () => ({}),
    },
  },
};
