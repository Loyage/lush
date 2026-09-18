import { intArg, jsonArg, next, UsageError } from '../args.js';
import { isPlainObject } from '../../core/types.js';

/**
 * `--title` / `--detail` are sugar for two reserved variable names the task
 * templates declare; they merge into the same object `--vars` builds, and the
 * same name given twice is a usage error instead of one option silently
 * winning over the other. The symbol remembers which option set which name so
 * the error can quote both sides; symbols never travel in RPC params.
 */
const VARIABLE_SOURCE = Symbol('variable source');

function setVariable(result, key, value, flag) {
  if (result.variables !== undefined && !isPlainObject(result.variables)) {
    throw new UsageError(`--vars must be a JSON object to combine with ${flag}`);
  }
  const sources = result[VARIABLE_SOURCE] ?? (result[VARIABLE_SOURCE] = {});
  if (sources[key] !== undefined) throw new UsageError(`${sources[key]} and ${flag} cannot both set ${key}`);
  result.variables = { ...(result.variables ?? {}), [key]: value };
  sources[key] = flag;
}

function setVariables(result, values, flag) {
  if (!isPlainObject(values)) return values;
  for (const [key, value] of Object.entries(values)) setVariable(result, key, value, flag);
  return result.variables;
}

/**
 * `service construct`: create one passive node. Work is never started here — the
 * new service only exists so a task can be delegated to it (`lush intent submit` or
 * `task_construct`).
 */
export const serviceConstructChild = {
  construct: {
    command: 'construct',
    method: 'service.construct',
    summary: '构造子服务',
    cover: [
      '在 PARENT 之下按 TEMPLATE 原子构造（创建并启动）一个子服务，成功后文本只打印新 SID。',
      '模板必须在创建方的 child_templates 白名单内；singleton 模板在同一父服务下已有活动实例时拒绝创建。',
      '子服务的 goal 取自 --goal，缺省时用名称；--vars 给出该模板声明的变量值，存入新服务 state（不可变变量在 state.params，可变变量在 state.vars）。',
      '--agent 指定该服务上的 task 使用的 agent profile（见 `lush agent list`），优先级高于模板的可选 agent 字段；两者都没有时用内置 default。选中的名字会写进 state，用 `service inspect` 可查。',
      '新建的服务是静止的：要让它干活，就说一句 `lush intent submit \'<原话>\' --sid <新SID>`（或让父 task 用 task_construct 派给它）。',
    ],
    notes: [
      '变量按模板的 variables 声明校验：缺少 required 变量、写了模板没声明的名字、或值不符合声明的格式（pattern / max_length / single_line）都会直接失败；带 default 的变量可以省略。',
      '保留变量名：`path` 是工作目录（必须是已存在的绝对目录，只能 immutable，也是这个服务上所有 task 的 cwd）；`name` 是服务名——声明了它的模板（如 dev-task）用它的声明校验 --name 的格式，--name 与 variables.name 是同一个值，两边给出不同值时拒绝；`title` / `detail` 是任务的一句话摘要与详情正文，list / tree / inspect 会渲染。',
      '--title / --detail 是 dev-task 这两个变量的便捷写法，与 --vars 合并：同一个名字不能两边都给。',
      '`project` 模板必须提供 variables.path，否则创建直接失败；`--args` 是 `--vars` 的旧写法，等价但已不建议使用。',
      '`--agent` 的名字必须合法且 profile 必须已存在（否则创建直接失败）；profile 属于本次 LUSH_HOME，见 `lush agent list`。',
    ],
    usage: ['lush service construct PARENT TEMPLATE [--name NAME] [--agent AGENT] [--goal GOAL] [--title TEXT] [--detail TEXT] [--vars JSON]'],
    positionals: [['PARENT', '父服务 SID'], ['TEMPLATE', '模板名，见父服务的 available_child_templates']],
    options: {
      '--name': {
        arg: 'NAME',
        desc: '服务名；省略时用模板名（模板声明了 name 变量时必填，格式按该变量声明校验）',
        apply: (r, v) => { r.name = v; },
      },
      '--agent': {
        arg: 'AGENT',
        desc: '该服务上的 task 使用的 agent profile（见 `lush agent list`）；省略时用模板的可选 agent 字段，再否则用内置 default',
        apply: (r, v) => { r.agent = v; },
      },
      '--goal': { arg: 'GOAL', desc: '这个节点长期的目标文本，写入 state.goal', apply: (r, v) => { r.goal = v; } },
      '--title': {
        arg: 'TEXT',
        desc: '任务一句话摘要（variables.title 的简写，单行）',
        apply: (r, v) => { setVariable(r, 'title', v, '--title'); },
      },
      '--detail': {
        arg: 'TEXT',
        desc: '任务详情正文（variables.detail 的简写，可多行）',
        apply: (r, v) => { setVariable(r, 'detail', v, '--detail'); },
      },
      '--vars': {
        arg: 'JSON',
        desc: '模板声明的变量值，按 immutable / mutable 存入新服务 state',
        apply: (r, v) => { r.variables = setVariables(r, jsonArg(v, '--vars'), '--vars'); },
      },
      '--args': {
        arg: 'JSON',
        desc: '--vars 的旧写法（等价，已不建议使用）',
        apply: (r, v) => { r.variables = setVariables(r, jsonArg(v, '--args'), '--args'); },
      },
    },
    parse: (args) => ({ parent_sid: intArg(args.shift(), 'parent_sid'), template: next(args, 'template') }),
  },
};
