/**
 * The variable system: what a template declares, what a process was created
 * with, and which region a caller may still change.
 *
 * Values live in the persistent state, split by mutability: immutable ones in
 * `state.params`, mutable ones in `state.vars`. The declaration a process was
 * created with (its template snapshot) decides what may change, so
 * immutability never depends on the caller's goodwill. `state.params` and
 * `state.vars` belong to this module: the generic `update_state` cannot write
 * them.
 *
 * Every function operates on the `ProcessManager` passed in (its repository),
 * or on the template declaration alone; the class in `process_manager.js` is
 * the only caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LushError, VARIABLE_GROUPS, isPlainObject, jsonDump } from './types.js';

/** Context state keys owned by the variable system; `update_state` must not touch them. */
export const VARIABLE_STATE_KEYS = ['params', 'vars'];

/**
 * Optional format constraints a declaration may carry on top of
 * `required` / `default` / `description`. They are checked twice: the
 * declaration at template load time (`checkVariableDeclaration`), the value at
 * spawn and update time (`checkVariableValue`). Constraints are declared, not
 * hard-coded, so a template states its own contract and the error message can
 * quote it back.
 */
export const VARIABLE_CONSTRAINT_FIELDS = ['pattern', 'max_length', 'single_line'];

/**
 * Variable names with a meaning of their own, the way an operating system
 * reserves a few file names. They are read by code outside the declaring
 * template, so their spelling is a contract:
 *
 * - `path` is the agent working directory (see `checkWorkdir`);
 * - `name` is the process name — `--name` and this variable are one value;
 * - `title` / `detail` are the task's one-line headline and its body, which
 *   the CLI renders in `process list` / `tree` / `inspect`
 *   (see `src/cli/format/primitives.js`).
 *
 * A template that declares none of them keeps the historical behaviour.
 */
export const RESERVED_VARIABLES = { workdir: 'path', processName: 'name', headline: 'title', body: 'detail' };

/** Short quote of a declaration's own description: the "why" half of a value error. */
function hint(spec, max = 160) {
  const description = typeof spec.description === 'string' ? spec.description.trim() : '';
  if (description === '') return '';
  return ` — ${description.length > max ? `${description.slice(0, max)}…` : description}`;
}

/**
 * Validate one declaration's constraint fields, and the `default` against
 * them, so a template that contradicts itself fails at load time instead of at
 * the first spawn.
 */
export function checkVariableDeclaration(templateName, group, name, spec) {
  if (Object.hasOwn(spec, 'pattern')) {
    if (typeof spec.pattern !== 'string' || spec.pattern.trim() === '' || spec.pattern.length > 200) {
      throw new LushError(`variable ${name} pattern must be a non-empty regular expression (max 200)`, -32602);
    }
    try {
      new RegExp(spec.pattern);
    } catch (err) {
      throw new LushError(`variable ${name} pattern is not a valid regular expression: ${err.message}`, -32602);
    }
  }
  if (Object.hasOwn(spec, 'max_length')
    && (!Number.isInteger(spec.max_length) || spec.max_length < 1 || spec.max_length > 100_000)) {
    throw new LushError(`variable ${name} max_length must be an integer between 1 and 100000`, -32602);
  }
  if (Object.hasOwn(spec, 'single_line') && typeof spec.single_line !== 'boolean') {
    throw new LushError(`variable ${name} single_line must be a boolean`, -32602);
  }
  if (group === 'mutable' && name === RESERVED_VARIABLES.processName) {
    throw new LushError('variable name must be immutable: it is the process name', -32602);
  }
  if (Object.hasOwn(spec, 'default')) checkVariableValue(templateName, name, spec.default, spec);
}

/**
 * Validate one value against the constraints its declaration carries. A
 * variable declaring none accepts any finite JSON value (the historical
 * behaviour); a constrained one must be a string, because `pattern` /
 * `max_length` / `single_line` are rules about text.
 */
export function checkVariableValue(templateName, name, value, spec) {
  if (!VARIABLE_CONSTRAINT_FIELDS.some((field) => Object.hasOwn(spec, field))) return value;
  const why = hint(spec);
  if (typeof value !== 'string') {
    throw new LushError(`template ${templateName} variable ${name} must be a string${why}`, -32602);
  }
  if (Object.hasOwn(spec, 'max_length') && value.length > spec.max_length) {
    throw new LushError(
      `template ${templateName} variable ${name} is ${value.length} characters, over the max_length ${spec.max_length}${why}`,
      -32602,
    );
  }
  if (spec.single_line === true && /[\u0000-\u001f\u007f]/.test(value)) {
    throw new LushError(
      `template ${templateName} variable ${name} must be a single line without control characters (single_line)${why}`,
      -32602,
    );
  }
  // Anchored on purpose: a pattern describes the whole value, so `[a-z]+` and
  // `^[a-z]+$` mean the same thing instead of quietly accepting a substring.
  if (Object.hasOwn(spec, 'pattern') && !new RegExp(`^(?:${spec.pattern})$`).test(value)) {
    throw new LushError(
      `template ${templateName} variable ${name} value ${JSON.stringify(value)} does not match /${spec.pattern}/${why}`,
      -32602,
    );
  }
  return value;
}

/**
 * The reserved `name` variable a template declares, or null. Declaring it makes
 * that variable the process name: `--name` seeds it, a value passed as
 * `variables.name` names the process, and the declaration's constraints decide
 * the format — one name with one contract instead of two spellings that can
 * drift apart.
 */
export function processNameVariable(template) {
  for (const group of VARIABLE_GROUPS) {
    const spec = template.variables?.[group]?.[RESERVED_VARIABLES.processName];
    if (spec !== undefined) return { group, spec };
  }
  return null;
}

/**
 * Seed the reserved `name` variable from the process name so either spelling
 * works, and refuse the ambiguous case (both given, disagreeing) instead of
 * silently picking one.
 */
export function withProcessName(template, name, variables) {
  const declared = processNameVariable(template);
  if (declared === null) return variables;
  const values = variables === undefined || variables === null ? {} : variables;
  // Not a plain object: leave the shape error to spawnVariables, which owns it.
  if (!isPlainObject(values)) return variables;
  if (Object.hasOwn(values, RESERVED_VARIABLES.processName)) {
    if (name !== undefined && name !== null && name !== values[RESERVED_VARIABLES.processName]) {
      throw new LushError(
        `name and variables.name disagree: ${JSON.stringify(name)} vs ${JSON.stringify(values[RESERVED_VARIABLES.processName])}; they are the same value`,
        -32602,
      );
    }
    return values;
  }
  if (name === undefined || name === null) {
    throw new LushError(
      `template ${template.name} requires a process name: pass name (CLI --name) or variables.name${hint(declared.spec)}`,
      -32602,
    );
  }
  return { ...values, [RESERVED_VARIABLES.processName]: name };
}

/** The process name a template's reserved `name` variable resolved to, or null. */
export function declaredProcessName(template, resolved) {
  const declared = processNameVariable(template);
  return declared === null ? null : resolved[declared.group][RESERVED_VARIABLES.processName];
}

/**
 * Resolve creation-time variables against the template declaration. Only
 * declared names are accepted, required ones must be present, declared
 * defaults fill the rest, and the result is split into the two mutability
 * regions that `Repository.create` stores. `path` keeps its
 * working-directory contract: an absolute directory that must already exist,
 * and every value must satisfy the constraints its declaration carries.
 */
export function spawnVariables(template, variables) {
  const declared = template.variables ?? {};
  const values = variables === undefined || variables === null ? {} : variables;
  if (!isPlainObject(values) || Object.getOwnPropertySymbols(values).length) {
    throw new LushError('variables must be a JSON object with string keys', -32602);
  }
  jsonDump(values);
  const specs = [];
  for (const group of VARIABLE_GROUPS) {
    for (const [name, spec] of Object.entries(declared[group] ?? {})) specs.push({ name, group, spec });
  }
  const known = new Set(specs.map((entry) => entry.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) {
      throw new LushError(`template ${template.name} does not declare variable ${name}`, -32602);
    }
  }
  const resolved = { immutable: {}, mutable: {} };
  for (const { name, group, spec } of specs) {
    if (Object.hasOwn(values, name)) resolved[group][name] = values[name];
    else if (Object.hasOwn(spec, 'default')) resolved[group][name] = spec.default;
    else if (spec.required === true) {
      throw new LushError(`template ${template.name} requires variables.${name}${hint(spec)}`, -32602);
    }
    if (Object.hasOwn(resolved[group], name)) checkVariableValue(template.name, name, resolved[group][name], spec);
  }
  if (Object.hasOwn(resolved.immutable, RESERVED_VARIABLES.workdir)) checkWorkdir(resolved.immutable.path);
  return resolved;
}

/** The `path` variable is the agent working directory: absolute, and already a directory. */
export function checkWorkdir(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new LushError('variable path must be an absolute path', -32602);
  }
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new LushError(`variable path does not exist: ${value}`, -32602);
  }
  if (!stat.isDirectory()) throw new LushError(`variable path is not a directory: ${value}`, -32602);
}

export function updateState(manager, pid, patch) {
  manager.requireRunning(pid);
  if (!isPlainObject(patch) || Object.getOwnPropertySymbols(patch).length) {
    throw new LushError('patch must be a JSON object with string keys', -32602);
  }
  for (const key of Object.keys(patch)) {
    if (VARIABLE_STATE_KEYS.includes(key)) {
      throw new LushError(
        `state.${key} holds process variables; use process.update_vars to change mutable ones`,
        -32602,
      );
    }
  }
  jsonDump(patch);
  return manager.repository.updateState(pid, patch);
}

/**
 * Change mutable variables only. The declaration the process was created with
 * decides what may change, so immutability does not depend on the caller's
 * goodwill: an immutable or undeclared name is refused instead of written.
 */
export function updateVars(manager, pid, patch) {
  const process = manager.requireRunning(pid);
  if (!isPlainObject(patch) || Object.getOwnPropertySymbols(patch).length) {
    throw new LushError('patch must be a JSON object with string keys', -32602);
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new LushError('patch must name at least one variable', -32602);
  jsonDump(patch);
  const declarations = process.variables.declarations;
  for (const key of keys) {
    if (Object.hasOwn(declarations.mutable, key)) {
      // The declaration the process was created with is still the contract a
      // later update has to satisfy.
      checkVariableValue(process.template, key, patch[key], declarations.mutable[key]);
      continue;
    }
    if (Object.hasOwn(declarations.immutable, key)) {
      throw new LushError(`variable ${key} is immutable in template ${process.template}`, -32602);
    }
    throw new LushError(`template ${process.template} does not declare variable ${key}`, -32602);
  }
  return manager.repository.updateVars(pid, patch);
}
