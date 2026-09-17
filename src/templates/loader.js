import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LushError, isPlainObject, jsonDump, jsonLoad, text } from '../core/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_DIR = path.join(HERE, 'builtin');

const REQUIRED_FIELDS = new Set(['name', 'process_type', 'description', 'system_prompt', 'allowed_child_templates', 'initial_context']);

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
      for (const name of template.allowed_child_templates) {
        if (name !== '*' && !Object.hasOwn(this.templates, name)) {
          throw new LushError(`unknown child template ${name} in ${template.name}`, -32602);
        }
      }
    }
  }

  register(value) {
    if (!isPlainObject(value)) throw new LushError(`template must contain exactly ${[...REQUIRED_FIELDS].sort()}`, -32602);
    const keys = Object.keys(value);
    if (keys.length !== REQUIRED_FIELDS.size || keys.some((key) => !REQUIRED_FIELDS.has(key))) {
      throw new LushError(`template must contain exactly ${[...REQUIRED_FIELDS].sort()}`, -32602);
    }
    for (const field of ['name', 'description', 'system_prompt']) text(value[field], field, 100_000);
    if (Object.hasOwn(this.templates, value.name)) {
      throw new LushError(`duplicate template: ${value.name}`, -32602);
    }
    if (value.process_type !== 'service' && value.process_type !== 'task') {
      throw new LushError('invalid template process_type', -32602);
    }
    const allowed = value.allowed_child_templates;
    if (!Array.isArray(allowed) || allowed.some((name) => typeof name !== 'string' || name === '')) {
      throw new LushError('allowed_child_templates must be a list of names', -32602);
    }
    const ctx = value.initial_context;
    if (!isPlainObject(ctx) || Object.keys(ctx).some((key) => !['state', 'artifacts', 'references'].includes(key))) {
      throw new LushError('invalid initial_context', -32602);
    }
    if (!isPlainObject(ctx.state ?? {}) || ['artifacts', 'references'].some((key) => !Array.isArray(ctx[key] ?? []))) {
      throw new LushError('initial_context requires state object and artifacts/references arrays', -32602);
    }
    jsonDump(value);
    this.templates[value.name] = structuredClone(value);
  }

  get(name) {
    text(name, 'template', 200);
    if (!Object.hasOwn(this.templates, name)) throw new LushError(`template not found: ${name}`, -32004);
    return structuredClone(this.templates[name]);
  }
}
