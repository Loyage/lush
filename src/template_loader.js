import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LushError, VARIABLE_GROUPS, isPlainObject, jsonDump, jsonLoad, text } from './core/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Shipped templates live in the repository root `templates/` directory. */
export const BUILTIN_DIR = path.join(HERE, '..', 'templates');

/**
 * The exact template key set. `type` is the process type (`task` / `service`),
 * `singleton` limits creation to one active instance per parent PID,
 * `spawn_prompt` tells a creating agent how to spawn this template and which
 * variables it needs, `system_prompt` becomes the instance Call prompt,
 * `child_templates` is the creation-time whitelist of spawnable templates, and
 * `variables` declares the instance's variables (see `checkVariables`).
 */
export const REQUIRED_FIELDS = ['name', 'type', 'singleton', 'description', 'spawn_prompt', 'system_prompt', 'child_templates', 'variables'];

const VARIABLE_FIELDS = ['required', 'default', 'description'];

/**
 * A template's variables are its initial values for a new process, declared in
 * the two mutability groups that also decide where values are stored:
 * `immutable` (`state.params`) is fixed at creation, `mutable` (`state.vars`)
 * can be changed afterwards. Each declaration carries only what the creating
 * agent and the process itself must know: whether the value is required, its
 * default, and what it means. `path` keeps its working-directory contract, so
 * it may not be declared mutable.
 */
function checkVariables(value) {
  if (!isPlainObject(value)) {
    throw new LushError(`variables must be an object with ${VARIABLE_GROUPS.join(' / ')} groups`, -32602);
  }
  for (const group of Object.keys(value)) {
    if (!VARIABLE_GROUPS.includes(group)) {
      throw new LushError(`variables has unknown group: ${group} (expected ${VARIABLE_GROUPS.join(', ')})`, -32602);
    }
  }
  const seen = new Set();
  for (const group of VARIABLE_GROUPS) {
    const declarations = value[group] ?? {};
    if (!isPlainObject(declarations)) {
      throw new LushError(`variables.${group} must be an object of declarations`, -32602);
    }
    for (const [name, spec] of Object.entries(declarations)) {
      if (name.trim() === '') throw new LushError('variable names must be non-empty', -32602);
      if (seen.has(name)) throw new LushError(`variable declared in both groups: ${name}`, -32602);
      seen.add(name);
      if (!isPlainObject(spec)) throw new LushError(`variable ${name} must be an object`, -32602);
      for (const field of Object.keys(spec)) {
        if (!VARIABLE_FIELDS.includes(field)) {
          throw new LushError(`variable ${name} has unknown field: ${field} (expected ${VARIABLE_FIELDS.join(', ')})`, -32602);
        }
      }
      text(spec.description, `variables.${group}.${name}.description`, 1000);
      if (Object.hasOwn(spec, 'required') && typeof spec.required !== 'boolean') {
        throw new LushError(`variable ${name} required must be a boolean`, -32602);
      }
      if (spec.required === true && Object.hasOwn(spec, 'default')) {
        throw new LushError(`variable ${name} cannot be both required and defaulted`, -32602);
      }
      if (group === 'mutable' && name === 'path') {
        throw new LushError('variable path must be immutable: it is the agent working directory', -32602);
      }
      jsonDump(spec);
    }
  }
}

export class TemplateLoader {
  constructor(extraDir = null) {
    this.templates = {};
    const directories = [BUILTIN_DIR];
    if (extraDir !== null && extraDir !== undefined) directories.push(extraDir);
    for (const directory of directories) {
      if (!fs.existsSync(directory)) continue;
      const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
      for (const file of files) {
        const full = path.join(directory, file);
        try {
          this.register(jsonLoad(fs.readFileSync(full, 'utf8')));
        } catch (err) {
          throw new LushError(`invalid template ${full}: ${err.message}`, -32602);
        }
      }
    }
    for (const template of Object.values(this.templates)) {
      for (const name of template.child_templates) {
        if (name !== '*' && !Object.hasOwn(this.templates, name)) {
          throw new LushError(`unknown child template ${name} in ${template.name}`, -32602);
        }
      }
    }
  }

  register(value) {
    if (!isPlainObject(value)) throw new LushError(`template must contain exactly ${[...REQUIRED_FIELDS].sort()}`, -32602);
    const keys = Object.keys(value);
    if (keys.length !== REQUIRED_FIELDS.length || keys.some((key) => !REQUIRED_FIELDS.includes(key))) {
      throw new LushError(`template must contain exactly ${[...REQUIRED_FIELDS].sort()}`, -32602);
    }
    for (const field of ['name', 'description', 'spawn_prompt', 'system_prompt']) text(value[field], field, 100_000);
    if (value.type !== 'service' && value.type !== 'task') {
      throw new LushError('invalid template type', -32602);
    }
    if (typeof value.singleton !== 'boolean') {
      throw new LushError('singleton must be a boolean', -32602);
    }
    if (!Array.isArray(value.child_templates) || value.child_templates.some((name) => typeof name !== 'string' || name === '')) {
      throw new LushError('child_templates must be a list of names', -32602);
    }
    checkVariables(value.variables);
    if (Object.hasOwn(this.templates, value.name)) {
      throw new LushError(`duplicate template: ${value.name}`, -32602);
    }
    jsonDump(value);
    this.templates[value.name] = structuredClone(value);
  }

  /** Current definition for `name`, or null when no such template is loaded. */
  find(name) {
    return Object.hasOwn(this.templates, name) ? this.get(name) : null;
  }

  get(name) {
    text(name, 'template', 200);
    if (!Object.hasOwn(this.templates, name)) throw new LushError(`template not found: ${name}`, -32004);
    return structuredClone(this.templates[name]);
  }
}
