import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LushError, VARIABLE_GROUPS, isPlainObject, jsonDump, jsonLoad, text } from './core/types.js';
import {
  RESERVED_VARIABLES, VARIABLE_CONSTRAINT_FIELDS, checkVariableDeclaration,
} from './core/variables.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Shipped templates live in the repository root `templates/` directory. */
export const BUILTIN_DIR = path.join(HERE, '..', 'templates');

/**
 * The exact template key set. A template describes one kind of **service** (a
 * passive node: identity, permissions, variables); `singleton` limits creation to
 * one active instance per parent SID,
 * `spawn_prompt` tells a creating agent how to spawn this template and which
 * variables it needs, `system_prompt` becomes the instance Call prompt,
 * `child_templates` is the creation-time whitelist of spawnable templates (each
 * entry is a file path relative to the declaring template's own file — the
 * directory layout mirrors the spawn tree — or, for programmatic `register`
 * calls and older user templates, a bare template name), and `variables`
 * declares the instance's variables (see `checkVariables`).
 */
export const REQUIRED_FIELDS = ['name', 'singleton', 'description', 'spawn_prompt', 'system_prompt', 'child_templates', 'variables'];

/**
 * Optional template fields. `agent` names the agent profile a spawned instance
 * uses; `lush service spawn --agent <name>` overrides it. Every other extra key
 * stays an error, so a typo in a template still fails loudly.
 */
export const OPTIONAL_FIELDS = ['agent'];

const VARIABLE_FIELDS = ['required', 'default', 'description', ...VARIABLE_CONSTRAINT_FIELDS];

/**
 * A template's variables are its initial values for a new service, declared in
 * the two mutability groups that also decide where values are stored:
 * `immutable` (`state.params`) is fixed at creation, `mutable` (`state.vars`)
 * can be changed afterwards. Each declaration carries only what the creating
 * agent and the service itself must know: whether the value is required, its
 * default, what it means, and the format constraints (`pattern` /
 * `max_length` / `single_line`) that make the value renderable and usable.
 * Two names are reserved and have a contract beyond their own template:
 * `path` keeps its working-directory meaning, so it may not be declared
 * mutable, and `name` is the service name, so it may not be either.
 */
function checkVariables(value, templateName) {
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
      if (group === 'mutable' && name === RESERVED_VARIABLES.workdir) {
        throw new LushError('variable path must be immutable: it is the agent working directory', -32602);
      }
      // Constraint fields, and the reserved-name rules that depend on them.
      checkVariableDeclaration(templateName, group, name, spec);
      jsonDump(spec);
    }
  }
}

/**
 * Order templates by hierarchy level instead of by file name: `Object.values(
 * templates.templates)` is what agents read as `available_child_templates` (in
 * that order), and it should read root-first — lush-root → project-manager →
 * project → the tasks a project creates, not alphabetically.
 *
 * A template's level is the longest path from a template no one else spawns, so
 * one reachable at several depths lands below the deepest. Two `child_templates`
 * entries are not edges: `*` (every template would become a parent of every
 * other one) and a self-reference (several templates list themselves). A cycle
 * that survives both is cut at the edge being walked, so this always terminates.
 * Ties break on name, so the result never depends on file names.
 */
function hierarchyLevels(templates) {
  const parents = new Map(Object.keys(templates).map((name) => [name, []]));
  for (const [name, template] of Object.entries(templates)) {
    for (const child of template.child_templates) {
      if (child === '*' || child === name || !parents.has(child)) continue;
      parents.get(child).push(name);
    }
  }
  const levels = new Map();
  const onPath = new Set();
  const levelOf = (name) => {
    const known = levels.get(name);
    if (known !== undefined) return known;
    if (onPath.has(name)) return 0;
    onPath.add(name);
    let level = 0;
    for (const parent of parents.get(name)) level = Math.max(level, levelOf(parent) + 1);
    onPath.delete(name);
    levels.set(name, level);
    return level;
  };
  for (const name of Object.keys(templates)) levelOf(name);
  return levels;
}

/** Same templates, re-keyed in hierarchy order (see `hierarchyLevels`). */
function orderByHierarchy(templates) {
  const levels = hierarchyLevels(templates);
  const names = Object.keys(templates).sort((a, b) => {
    const byLevel = levels.get(a) - levels.get(b);
    if (byLevel !== 0) return byLevel;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.fromEntries(names.map((name) => [name, templates[name]]));
}

/**
 * Every `*.json` below `root`, as a path relative to it, in a deterministic
 * order (names sorted within each directory, files and subdirectories
 * interleaving by name). The templates themselves are sorted by hierarchy
 * afterwards, so this order only decides which duplicate is reported first.
 */
function templateFiles(root) {
  const found = [];
  const walk = (relative) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return; // no such directory: loading nothing is the same as an empty one
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const nested = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(nested);
      else if (entry.name.endsWith('.json')) found.push(nested);
    }
  };
  walk('');
  return found;
}

export class TemplateLoader {
  constructor(extraDir = null) {
    this.templates = {};
    /** Template name → the file it came from (a relative path resolves against its directory). */
    this.origins = new Map();
    /** Absolute file path → template name (the reverse lookup a relative path goes through). */
    this.files = new Map();
    const directories = [BUILTIN_DIR];
    if (extraDir !== null && extraDir !== undefined) directories.push(extraDir);
    for (const directory of directories) {
      // Register every file before resolving anything: a `child_templates` path
      // may point at a template that is loaded later, since the layout is the tree.
      const loaded = templateFiles(directory).map((relative) => {
        const full = path.join(directory, relative);
        try {
          return { full, value: jsonLoad(fs.readFileSync(full, 'utf8')) };
        } catch (err) {
          throw new LushError(`invalid template ${full}: ${err.message}`, -32602);
        }
      });
      for (const { full, value } of loaded) this.register(value, { file: full, resolve: false });
    }
    for (const template of Object.values(this.templates)) {
      const file = this.origins.get(template.name);
      template.child_templates = template.child_templates.map((entry) => this.resolveChild(entry, template.name, file));
    }
    this.templates = orderByHierarchy(this.templates);
  }

  /**
   * One `child_templates` entry → the template name it grants. `*` stays `*`.
   * An entry that names a file (`dev-task.json`, `../generic-task.json`, or any
   * `path/to/name.json`) is relative to the declaring template's own directory
   * and must point at a loaded template file; a bare name is looked up as a
   * name (programmatic `register` has no file to be relative to). Either way
   * the stored whitelist, the snapshot and the permission check only see names.
   */
  resolveChild(entry, templateName, file = null) {
    if (entry === '*') return '*';
    if (!entry.includes('/') && !entry.endsWith('.json')) {
      if (entry !== templateName && !Object.hasOwn(this.templates, entry)) {
        throw new LushError(`unknown child template ${entry} in ${templateName}`, -32602);
      }
      return entry;
    }
    if (file === null) {
      throw new LushError(`child template ${entry} in ${templateName} is a path, but ${templateName} was registered without a file`, -32602);
    }
    const target = path.resolve(path.dirname(file), entry);
    const name = this.files.get(target);
    if (name === undefined) {
      throw new LushError(`unknown child template ${entry} in ${templateName}: no template file at ${target}`, -32602);
    }
    return name;
  }

  register(value, { file = null, resolve = true } = {}) {
    if (!isPlainObject(value)) throw new LushError(`template must contain exactly ${[...REQUIRED_FIELDS].sort()}`, -32602);
    const missing = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(value, field));
    const unknown = Object.keys(value).filter((key) => !REQUIRED_FIELDS.includes(key) && !OPTIONAL_FIELDS.includes(key));
    if (missing.length || unknown.length) {
      throw new LushError(`template must contain exactly ${[...REQUIRED_FIELDS].sort()}`
        + (OPTIONAL_FIELDS.length ? ` (optional: ${OPTIONAL_FIELDS.join(', ')})` : ''), -32602);
    }
    for (const field of ['name', 'description', 'spawn_prompt', 'system_prompt']) text(value[field], field, 100_000);
    // Optional: which agent profile new instances use unless --agent overrides it.
    if (Object.hasOwn(value, 'agent')) text(value.agent, 'agent', 200);
    if (typeof value.singleton !== 'boolean') {
      throw new LushError('singleton must be a boolean', -32602);
    }
    if (!Array.isArray(value.child_templates) || value.child_templates.some((name) => typeof name !== 'string' || name === '')) {
      throw new LushError('child_templates must be a list of names', -32602);
    }
    checkVariables(value.variables, value.name);
    if (Object.hasOwn(this.templates, value.name)) {
      throw new LushError(`duplicate template: ${value.name}`, -32602);
    }
    jsonDump(value);
    const template = structuredClone(value);
    if (file !== null) this.files.set(path.resolve(file), template.name);
    // `resolve: false` defers the whitelist while a directory is being loaded:
    // a relative path there may name a file that is only registered later.
    if (resolve) {
      template.child_templates = template.child_templates.map((entry) => this.resolveChild(entry, template.name, file));
    }
    this.templates[template.name] = template;
    this.origins.set(template.name, file === null ? null : path.resolve(file));
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
