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
 * Resolve creation-time variables against the template declaration. Only
 * declared names are accepted, required ones must be present, declared
 * defaults fill the rest, and the result is split into the two mutability
 * regions that `Repository.create` stores. `path` keeps its
 * working-directory contract: an absolute directory that must already exist.
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
      throw new LushError(`template ${template.name} requires variables.${name}`, -32602);
    }
  }
  if (Object.hasOwn(resolved.immutable, 'path')) checkWorkdir(resolved.immutable.path);
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
    if (Object.hasOwn(declarations.mutable, key)) continue;
    if (Object.hasOwn(declarations.immutable, key)) {
      throw new LushError(`variable ${key} is immutable in template ${process.template}`, -32602);
    }
    throw new LushError(`template ${process.template} does not declare variable ${key}`, -32602);
  }
  return manager.repository.updateVars(pid, patch);
}
