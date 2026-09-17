import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LushError, isPlainObject, jsonDump, jsonLoad, text } from './core/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Shipped templates live in the repository root `templates/` directory. */
export const BUILTIN_DIR = path.join(HERE, '..', 'templates');

/**
 * The exact template key set. `type` is the process type (`task` / `service`),
 * `singleton` limits creation to one active instance per parent PID,
 * `spawn_prompt` tells a creating agent how to spawn this template and which
 * arguments it needs, `system_prompt` becomes the instance Call prompt, and
 * `child_templates` is the creation-time whitelist of spawnable templates.
 */
export const REQUIRED_FIELDS = ['name', 'type', 'singleton', 'description', 'spawn_prompt', 'system_prompt', 'child_templates'];

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
