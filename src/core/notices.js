/**
 * The notice channel: how a task's agent reports to the user.
 *
 * A **notice** is one message from a piece of work to the human watching it:
 * "I am blocked", "this needs your decision", "here is the result". It carries
 * the reporter's identity (`task_id` + its `sid`), what is needed (`kind`,
 * `title`, `body`), and — when the user has something to fill in — a declared
 * answer form (`fields`).
 *
 * Reporting never blocks. A notice with `wait` (the default) **attaches the
 * reporter to itself**: the task parks in `awaiting`, and settling the notice
 * hands the answer back through the task's inbox as one more piece of input
 * (`core/tasks/messages.js`). So the answer arrives at the agent the same way a
 * child's result does — between two invocations — instead of being waited for
 * inside one. A `wait: false` notice is a pure record: it neither parks the
 * reporter nor comes back to it.
 *
 * The rules live here; the rows are in `persistence/repository_notices.js` and
 * the wire signatures in `service_manager/notices.js`.
 */
import { LushError, isPlainObject, text, validSid } from './types.js';
import { notifyNoticeSettled } from './tasks/messages.js';

/** What the report is for: a result to read, a decision to make, a blocker. */
export const NOTICE_KINDS = ['report', 'decision', 'blocked'];

/** The answer form's field types; each maps to one input in every adapter. */
export const NOTICE_FIELD_TYPES = ['text', 'textarea', 'choice', 'boolean'];

/** A notice is open until the user answers or dismisses it. */
export const NOTICE_STATUSES = ['open', 'answered', 'dismissed'];

const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_LABEL = 200;
const MAX_VALUE = 20_000;
const MAX_NOTE = 2_000;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function requireNotice(manager, noticeId) {
  validSid(noticeId);
  return manager.repository.getNotice(noticeId);
}

/** The compact shape a reporter sees back (and the list rows' identity). */
export function summary(notice) {
  return {
    id: notice.id,
    sid: notice.sid,
    task_id: notice.task_id,
    kind: notice.kind,
    title: notice.title,
    status: notice.status,
    wait: notice.wait,
    created_at: notice.created_at,
  };
}

/**
 * Validate and normalize an answer form. A field is
 * `{ name, label?, type?, required?, options?, default? }`; the returned array
 * is what gets stored, so readers never have to repeat the defaults.
 */
export function validateFields(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new LushError('fields must be an array of field declarations', -32602);
  if (value.length > MAX_FIELDS) throw new LushError(`fields must have at most ${MAX_FIELDS} entries`, -32602);
  const seen = new Set();
  return value.map((field) => {
    if (!isPlainObject(field)) throw new LushError('each field must be an object', -32602);
    for (const key of Object.keys(field)) {
      if (!['name', 'label', 'type', 'required', 'options', 'default'].includes(key)) {
        throw new LushError(`field has unexpected property '${key}'`, -32602);
      }
    }
    const name = text(field.name, 'field.name', 64);
    if (!FIELD_NAME.test(name)) {
      throw new LushError(`field.name must match ${FIELD_NAME} (got '${name}')`, -32602);
    }
    if (seen.has(name)) throw new LushError(`duplicate field name '${name}'`, -32602);
    seen.add(name);

    const type = field.type ?? 'text';
    if (!NOTICE_FIELD_TYPES.includes(type)) {
      throw new LushError(`field '${name}': type must be one of ${NOTICE_FIELD_TYPES.join(', ')}`, -32602);
    }
    const label = field.label === undefined ? name : text(field.label, `field '${name}' label`, MAX_LABEL);
    const required = field.required ?? false;
    if (typeof required !== 'boolean') {
      throw new LushError(`field '${name}': required must be a boolean`, -32602);
    }

    const normalized = { name, label, type, required };
    if (type === 'choice') {
      const options = field.options;
      if (!Array.isArray(options) || options.length === 0) {
        throw new LushError(`field '${name}': a choice field needs a non-empty options array`, -32602);
      }
      if (options.length > MAX_OPTIONS) {
        throw new LushError(`field '${name}': at most ${MAX_OPTIONS} options`, -32602);
      }
      normalized.options = options.map((option) => text(option, `field '${name}' option`, MAX_VALUE));
      if (new Set(normalized.options).size !== normalized.options.length) {
        throw new LushError(`field '${name}': duplicate options`, -32602);
      }
    } else if (field.options !== undefined) {
      throw new LushError(`field '${name}': options is only allowed on a choice field`, -32602);
    }
    if (field.default !== undefined) {
      normalized.default = coerceValue(normalized, field.default);
    }
    return normalized;
  });
}

/** One declared field's value: type-checked and normalized to its stored form. */
function coerceValue(field, raw) {
  const where = `field '${field.name}'`;
  if (field.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    // The CLI hands every `--set k=v` over as a string; accept the two obvious ones.
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new LushError(`${where}: expected a boolean`, -32602);
  }
  if (typeof raw !== 'string') throw new LushError(`${where}: expected a string`, -32602);
  if (field.type === 'choice') {
    if (!field.options.includes(raw)) {
      throw new LushError(`${where}: '${raw}' is not one of ${field.options.join(', ')}`, -32602);
    }
    return raw;
  }
  // text / textarea
  if (raw.length > MAX_VALUE) throw new LushError(`${where}: value is too long (max ${MAX_VALUE})`, -32602);
  return raw;
}

const isScalar = (value) => typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));

/**
 * The user's answer against the form the reporter declared. Declared fields are
 * enforced (required, choices, types); an undeclared field without a form is a
 * free-form answer, so only its shape is checked. Missing optional fields with a
 * declared `default` are filled in, so the reporter always sees the same keys.
 */
export function normalizeAnswer(fields, value) {
  if (!isPlainObject(value)) throw new LushError('answer must be a JSON object', -32602);
  const declared = fields ?? [];
  const byName = new Map(declared.map((field) => [field.name, field]));
  const answer = {};
  for (const [key, raw] of Object.entries(value)) {
    const field = byName.get(key);
    if (field === undefined) {
      if (declared.length > 0) throw new LushError(`answer has undeclared field '${key}'`, -32602);
      if (!isScalar(raw)) throw new LushError(`answer '${key}' must be a string, number or boolean`, -32602);
      answer[key] = raw;
      continue;
    }
    answer[key] = coerceValue(field, raw);
  }
  for (const field of declared) {
    const present = Object.hasOwn(answer, field.name);
    if (field.required && (!present || answer[field.name] === '')) {
      throw new LushError(`answer is missing required field '${field.name}'`, -32602);
    }
    if (!present && field.default !== undefined) answer[field.name] = field.default;
  }
  return answer;
}

/**
 * Report to the user. The reporter is the task itself, so `sid` is read from
 * the task rather than trusted from the caller. Returns the stored notice.
 */
export function post(manager, { taskId, kind = 'report', title, body = '', fields, wait = true }) {
  validSid(taskId);
  const task = manager.repository.getTask(taskId); // not found reports -32004
  text(title, 'title', MAX_TITLE);
  if (typeof body !== 'string' || body.length > MAX_BODY) {
    throw new LushError(`body must be a string (max ${MAX_BODY})`, -32602);
  }
  if (!NOTICE_KINDS.includes(kind)) {
    throw new LushError(`kind must be one of ${NOTICE_KINDS.join(', ')}`, -32602);
  }
  if (typeof wait !== 'boolean') throw new LushError('wait must be a boolean', -32602);
  const declared = validateFields(fields);
  const notice = manager.repository.createNotice(task.sid, taskId, {
    kind, title, body, fields: declared, wait,
  });
  manager.repository.taskEvent(taskId, 'notice', {
    notice_id: notice.id, kind, title, wait: notice.wait,
  });
  return notice;
}

export function list(manager, { status = null, taskId = null, sid = null, limit = 200 } = {}) {
  if (status !== null && !NOTICE_STATUSES.includes(status)) {
    throw new LushError(`status must be one of ${NOTICE_STATUSES.join(', ')}`, -32602);
  }
  if (taskId !== null) validSid(taskId);
  if (sid !== null) validSid(sid);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new LushError('limit must be an integer in 1..1000', -32602);
  }
  return manager.repository.listNotices({ status, taskId, sid, limit });
}

export function inspect(manager, noticeId) {
  return requireNotice(manager, noticeId);
}

export function openCount(manager) {
  return manager.repository.openNoticeCount();
}

/**
 * How many notices this task reported that still need the user (`wait` ones).
 * This is what makes a task `awaiting` rather than running: the user owes it an
 * answer, and the task may not settle until that answer is handed back.
 */
export function awaitingCount(manager, taskId) {
  validSid(taskId);
  return manager.repository.countAwaitingNotices(taskId);
}

/** Answer one notice; the reporter is handed the values the user filled in. */
export function answer(manager, noticeId, value) {
  const notice = requireNotice(manager, noticeId);
  if (notice.status !== 'open') {
    throw new LushError(`notice ${noticeId} is ${notice.status}; it can no longer be answered`, -32010);
  }
  const filled = normalizeAnswer(notice.fields, value);
  const updated = manager.repository.settleNotice(noticeId, 'answered', { answer: filled });
  notifyNoticeSettled(manager, updated);
  return updated;
}

/** Dismiss one notice without answering (a report the user has read, or noise). */
export function dismiss(manager, noticeId, reason = null) {
  const notice = requireNotice(manager, noticeId);
  if (notice.status !== 'open') {
    throw new LushError(`notice ${noticeId} is ${notice.status}; it can no longer be dismissed`, -32010);
  }
  if (reason !== null && (typeof reason !== 'string' || reason.length > MAX_NOTE)) {
    throw new LushError(`reason must be a string (max ${MAX_NOTE})`, -32602);
  }
  const updated = manager.repository.settleNotice(noticeId, 'dismissed', { note: reason });
  notifyNoticeSettled(manager, updated);
  return updated;
}

/**
 * The reporter is gone (its task failed or was cancelled): dismiss whatever it
 * was still waiting on, so nobody is left answering a question whose asker is
 * gone. Called from the task layer's terminal transition, which also wakes the
 * task's own parking loop.
 */
export function terminate(manager, taskId, reason) {
  const dismissed = [];
  for (const notice of manager.repository.openNoticesOfTask(taskId)) {
    manager.repository.settleNotice(notice.id, 'dismissed', { note: reason });
    dismissed.push(notice.id);
  }
  return dismissed;
}
