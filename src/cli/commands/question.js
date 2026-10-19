import fs from 'node:fs';
import { check, text, isPlainObject } from '../../core/types.js';
import { questionnaire } from '../../core/questionnaire.js';
import { positionalArguments, cliOption } from './intent.js';

// Local construction only: no project discovery, credentials, RPC or Worker state.
function readJSON(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    check(stat.isFile(), 'question file must be a regular file');
    check(stat.size <= 256000, 'question file exceeds 256000 bytes');
    const source = fs.readFileSync(fd, 'utf8');
    check(Buffer.byteLength(source) <= 256000, 'question file exceeds 256000 bytes');
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid question file ${JSON.stringify(file)}: ${error.message}. Use lushw question example for a template.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function questionsFromJSON(source, body) {
  const value = JSON.parse(source);
  check(Array.isArray(value?.questions), 'questions JSON must contain {questions:[...]}');
  questionnaire(body, value.questions);
  return value.questions;
}

// Both default construction JSON and the explicit --json CLI envelope are
// generated artifacts. Unwrap only the exact public envelope, never arbitrary data.
function constructionPayload(value) {
  return isPlainObject(value) && value.version === 1 && Object.hasOwn(value, 'data')
    && Object.keys(value).every(key => ['version','data'].includes(key)) ? value.data : value;
}
export function questionsFromFile(file, body) {
  const value = constructionPayload(readJSON(file));
  check(Array.isArray(value?.questions), 'questions file must contain {questions:[...]}');
  questionnaire(body, value.questions);
  return value.questions;
}

function createQuestion(title, body, questions) {
  text(title, 'title');
  const form = JSON.parse(questionnaire(body, questions));
  return { version: 1, title, body: form.body, questions: form.questions };
}

export function questionFromFile(file) {
  const value = constructionPayload(readJSON(file));
  check(isPlainObject(value) && Object.keys(value).every(key => ['version','title','body','questions'].includes(key))
    && value.version === 1, 'question file must be {version:1,title,body,questions}; use lushw question create');
  return createQuestion(value.title, value.body, value.questions);
}

export async function run(command, args) {
  const verb = args.shift();
  if (verb === 'example') {
    positionalArguments(args, 0);
    return { questions: [{
      header: '方案选择', question: '本次改进采用哪种实现方案？',
      options: [
        { label: '复用现有实现（推荐）', description: '保持现有接口，改动较小；受现有结构限制。' },
        { label: '新增独立实现', description: '隔离新行为，但增加维护和集成成本。' },
      ], multiSelect: false,
    }] };
  }
  if (verb === 'create') {
    const file = cliOption(args, '--questions-file'), body = cliOption(args, '--body', '');
    positionalArguments(args, 1); check(file !== null, '--questions-file is required');
    return createQuestion(args[0], body, questionsFromFile(file, body));
  }
  check(verb === 'check', 'unknown question command');
  const file = cliOption(args, '--question-file');
  positionalArguments(args, 0); check(file !== null, '--question-file is required');
  const form = questionFromFile(file);
  return { valid: true, question_count: form.questions.length };
}
