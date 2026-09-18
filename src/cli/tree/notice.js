import { intArg, jsonArg, UsageError } from '../args.js';

/** `--set name=value` → `[name, value]`; a bare name is a usage error. */
function setArg(value) {
  const index = value.indexOf('=');
  if (index <= 0) throw new UsageError(`argument --set: expected KEY=VALUE, got '${value}'`);
  return [value.slice(0, index), value.slice(index + 1)];
}

/**
 * The `notice` command group: the user's side of the notice channel.
 *
 * A **notice** is how a task's agent talks to the person watching it — it is
 * blocked, it needs a decision, or it has a result to hand over. The agent
 * declares the answer it needs (`fields`), the user fills it in with
 * `notice answer`, and the reporter is unblocked with those values. A report
 * nobody has to answer is just a notice to read and `dismiss`.
 */
export const noticeGroup = {
  summary: 'Notice：agent 汇报给用户（等待决策 / 填空 / 阅读）的消息',
  cover: [
    'notice 是 task 的 agent 向用户的一条报告：kind 为 report（结果 / 发现）、decision（需要你定）或 blocked（它做不下去）；title 是一句话，body 是完整上下文。',
    '需要你填写时，agent 会在 fields 里声明表单（name / label / type=text|textarea|choice|boolean / required / options / default）；`notice answer` 填的就是它。',
    'agent 默认会阻塞等待：在它回答之前，上报的 task 停在 waiting（暂停超时）。wait=false 的 notice 只登记、不阻塞。',
    '用户这一侧：list 看待处理项、show 看详情与字段、answer 填写回复、dismiss 忽略。agent 那一侧用 `notice` 工具上报。',
    'notice 不超时：没人处理的 notice 会一直挂着，直到你 answer / dismiss，或它所属的 task 被 cancel（那会把它的未决 notice 一起忽略）。',
  ],
  notes: [
    'status：open（等待处理）→ answered（已填写）/ dismissed（已忽略）；answered 的 notice 会带上你填的 answer 对象。',
    '回复必须是合法 JSON 对象：有 fields 时只接受声明的字段名，必填项不能为空，choice 必须命中 options，boolean 接受 true/false。',
    '只有上报它的那个 task 能等待它；别的 task 不能替你回答，也不能替它等。',
  ],
  children: {
    list: {
      command: 'notice_list',
      method: 'notice.list',
      summary: '列出 notice（默认最近的在前，最多 200 条）',
      cover: [
        '一行一条：ID、kind、status、title、上报的 task 与 service。',
        '--status open 只看等待处理的；--task 只看某个 task 上报的；--sid 只看某个 service 上的。',
      ],
      usage: ['lush notice list [--status open|answered|dismissed] [--task TASK_ID] [--sid SID] [--limit N]'],
      options: {
        '--status': {
          arg: 'STATUS',
          desc: '只看某个状态：open / answered / dismissed',
          apply: (r, v) => { r.status = v; },
        },
        '--task': {
          arg: 'TASK_ID',
          desc: '只看这个 task 上报的 notice',
          apply: (r, v) => { r.task_id = intArg(v, '--task'); },
        },
        '--sid': {
          arg: 'SID',
          desc: '只看挂在这个 service 上的 notice',
          apply: (r, v) => { r.sid = intArg(v, '--sid'); },
        },
        '--limit': { arg: 'N', desc: '最多返回多少条（默认 200）', apply: (r, v) => { r.limit = intArg(v, '--limit'); } },
      },
      parse: () => ({}),
    },
    show: {
      command: 'notice_show',
      method: 'notice.inspect',
      summary: '查看一条 notice 的详情与它声明要填的字段',
      cover: [
        '完整正文、上报者身份（task / service）、kind、status，以及 fields 声明的表单和你已经填过的 answer。',
        '--json 给出完整快照，适合脚本化填写。',
      ],
      usage: ['lush notice show NOTICE_ID'],
      positionals: [['NOTICE_ID', 'notice 的 id']],
      parse: (args) => ({ notice_id: intArg(args.shift(), 'notice_id') }),
    },
    answer: {
      command: 'notice_answer',
      method: 'notice.answer',
      summary: '填写并提交对一条 notice 的回复（上报者会被唤醒）',
      cover: [
        '--set name=value 可重复，按字段名填写 fields 里声明的表单；没有声明字段时用 --text 给自由文本（等价 --set text=...）。',
        '--answer JSON 直接给完整对象，适合脚本；它不能和 --set / --text 混用。',
        '提交后 notice 变为 answered，答案存进它的 answer；正在等待的 task 会拿到 { status, answer } 并继续。',
      ],
      notes: [
        '已 answered / dismissed 的 notice 不能再回答（报错），先 `notice show` 看状态。',
        'choice 字段的值必须命中声明里的 options；boolean 写成 true / false。',
      ],
      usage: [
        'lush notice answer NOTICE_ID --set FIELD=VALUE [--set FIELD=VALUE ...]',
        'lush notice answer NOTICE_ID --text TEXT',
        'lush notice answer NOTICE_ID --answer JSON',
      ],
      positionals: [['NOTICE_ID', 'notice 的 id']],
      options: {
        '--set': {
          arg: 'KEY=VALUE',
          desc: '填写一个声明字段（可重复）',
          apply: (r, v) => { r.set.push(setArg(v)); },
        },
        '--text': { arg: 'TEXT', desc: '自由文本回答（等价 --set text=TEXT）', apply: (r, v) => { r.text = v; } },
        '--answer': { arg: 'JSON', desc: '完整答案对象（不能与 --set / --text 混用）', apply: (r, v) => { r.answer_json = jsonArg(v, '--answer'); } },
      },
      parse: (args) => ({ notice_id: intArg(args.shift(), 'notice_id'), set: [] }),
      check: (r) => {
        const modes = [r.set.length > 0, r.text !== undefined, r.answer_json !== undefined].filter(Boolean).length;
        if (modes === 0) throw new UsageError('provide the answer: --set KEY=VALUE, --text TEXT, or --answer JSON');
        if (r.answer_json !== undefined && modes > 1) {
          throw new UsageError('--answer cannot be combined with --set or --text');
        }
        if (r.answer_json !== undefined) {
          r.answer = r.answer_json;
        } else {
          r.answer = Object.fromEntries(r.set);
          if (r.text !== undefined) r.answer.text = r.text;
        }
        delete r.set;
        delete r.text;
        delete r.answer_json;
      },
    },
    dismiss: {
      command: 'notice_dismiss',
      method: 'notice.dismiss',
      summary: '忽略一条 notice，不填答案',
      cover: [
        '用于已经读过的结果报告，或不需要处理的噪音；notice 变为 dismissed。',
        '--reason 记一段说明（可选），会存在 notice 的 note 里。正在等待的 task 会看到这条 note 并继续。',
      ],
      usage: ['lush notice dismiss NOTICE_ID [--reason TEXT]'],
      positionals: [['NOTICE_ID', 'notice 的 id']],
      options: {
        '--reason': { arg: 'TEXT', desc: '忽略原因（可选）', apply: (r, v) => { r.reason = v; } },
      },
      parse: (args) => ({ notice_id: intArg(args.shift(), 'notice_id') }),
    },
  },
};
