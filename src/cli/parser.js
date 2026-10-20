import { cliArguments, isOptionIndex } from './args.js';

export function cliParameterError(message) {
  return Object.assign(new Error(message), { exitCode: 2, execution: 'not_started', kind: 'invalid_parameters' });
}
const requireValue = (condition, message) => { if (!condition) throw cliParameterError(message); };

export function commandFor(args, commands) {
  return commands.filter(item => !item.directory && item.path.split(' ').every((part, index) => isOptionIndex(args, index) && args[index] === part))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

// Executable/view come only from the fixed entry or trusted bridge, never argv.
export function parseCLI(argv, commands) {
  requireValue(Array.isArray(argv) && argv.every(arg => typeof arg === 'string' && !arg.includes('\0')), 'invalid CLI arguments');
  const args = cliArguments(argv);
  let project = null, json = false;
  for (const flag of ['--project', '--json']) {
    let seen = false;
    for (let index = 0; index < args.length; index++) {
      if (!isOptionIndex(args, index) || args[index] !== flag) continue;
      requireValue(!seen, `duplicate ${flag}`); seen = true;
      if (flag === '--json') { json = true; args.splice(index--, 1); }
      else {
        requireValue(isOptionIndex(args, index + 1) && args[index + 1] && !args[index + 1].startsWith('--'), '--project requires PATH');
        project = args[index + 1]; args.splice(index--, 2);
      }
    }
  }
  const helpFlag = args.findIndex((value, index) => isOptionIndex(args, index) && ['--help','-h'].includes(value));
  const help = !args.length || isOptionIndex(args, 0) && args[0] === 'help' || helpFlag >= 0;
  if (help) {
    let helpArgs;
    if (args[0] === 'help' && isOptionIndex(args, 0)) { args.shift(); helpArgs = args; }
    else {
      const prefix = args.slice(0, helpFlag < 0 ? args.length : helpFlag);
      const entry = commands.filter(item => item.path.split(' ').every((part, index) => prefix[index] === part))
        .sort((a, b) => b.path.length - a.path.length)[0];
      helpArgs = (entry?.path ?? prefix.filter(value => !value.startsWith('-')).join(' ')).split(' ').filter(Boolean);
    }
    return { args, project, json, help: true, helpArgs };
  }
  return { args, project, json, help: false, entry: commandFor(args, commands) };
}

export function syntaxParameters(entry) {
  const source = entry.usage?.slice(`lush ${entry.path}`.length) ?? '';
  const options = {};
  const matcher = /--([a-z][a-z0-9-]*)(?:\s+([A-Z][A-Za-z0-9_\/|.-]*|true\|false|on\|off|[a-z]+\|[a-z|]+))?/g;
  for (const match of source.matchAll(matcher)) {
    const token = match[2], flag = `--${match[1]}`;
    const type = token === 'JSON' ? 'json' : token === 'N' ? 'integer' : token === 'true|false' ? 'boolean' : 'string';
    options[flag] = { type, arity: token ? 1 : 0, ...(token?.includes('|') && /^[a-z|]+$/.test(token) ? { enum: token.split('|') } : {}),
      ...(['--after-settled','--after-merged'].includes(flag) ? { repeatable: true } : {}) };
  }
  for (const [flag, definition] of Object.entries(entry.parameters?.options ?? {})) {
    options[flag] = { ...options[flag], ...definition,
      arity: definition.arity ?? (definition.flag === true || definition.takesValue === false || definition.takes_value === false ? 0
        : definition.type === 'boolean' ? options[flag]?.arity ?? 0 : 1) };
  }
  return { ...entry.parameters, positional_validation: entry.parameters?.positional_validation ?? Boolean(entry.parameters?.positionals),
    positionals: entry.parameters?.positionals ?? [], options };
}

function matchesCLIValue(schema, raw) {
  if (schema.anyOf) return schema.anyOf.some(part => matchesCLIValue(part, raw));
  if (schema.oneOf) return schema.oneOf.filter(part => matchesCLIValue(part, raw)).length === 1;
  if (schema.type === 'integer' || schema.type === 'number') return /^(?:0|[1-9][0-9]*)$/.test(raw)
    && Number.isSafeInteger(Number(raw)) && matchesJSONSchema(schema, Number(raw));
  if (schema.type === 'boolean') return ['true','false'].includes(raw);
  return matchesJSONSchema({ ...schema, type: schema.type === 'json' ? undefined : schema.type }, raw);
}
// Bounded, pure validation of the published structural payload contracts. Domain
// formats and authorization are independently checked by the existing RPC engine.
export function matchesJSONSchema(schema, value, depth = 0) {
  if (!schema || depth > 32) return false;
  if (Array.isArray(schema.type)) return schema.type.some(type => matchesJSONSchema({ ...schema, type }, value, depth + 1));
  const matches = part => matchesJSONSchema(part, value, depth + 1);
  if (schema.anyOf && !schema.anyOf.some(matches)) return false;
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(matches)) return false;
  if (schema.not && matches(schema.not)) return false;
  if (schema.if && !matches(matches(schema.if) ? schema.then ?? {} : schema.else ?? {})) return false;
  // Applicator branches may omit type (required/properties still constrain objects).
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (!(schema.required ?? []).every(key => Object.hasOwn(value, key))) return false;
    if (!Object.entries(schema.properties ?? {}).every(([key, part]) => !Object.hasOwn(value, key) || matchesJSONSchema(part, value[key], depth + 1))) return false;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer' || schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isSafeInteger(value))
    && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'string') return typeof value === 'string'
    && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength)
    && (schema.maxBytes === undefined || Buffer.byteLength(value) <= schema.maxBytes)
    && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'array') return Array.isArray(value)
    && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && (!schema.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length)
    && (!schema.items || value.every(item => matchesJSONSchema(schema.items, item, depth + 1)));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value), properties = schema.properties ?? {};
    return (!schema.maxProperties || keys.length <= schema.maxProperties) && (!schema.minProperties || keys.length >= schema.minProperties)
      && (schema.required ?? []).every(key => Object.hasOwn(value, key))
      && keys.every(key => (!schema.propertyNames || matchesJSONSchema(schema.propertyNames, key, depth + 1))
        && (Object.hasOwn(properties, key) ? matchesJSONSchema(properties[key], value[key], depth + 1)
          : schema.additionalProperties === false ? false : typeof schema.additionalProperties === 'object'
            ? matchesJSONSchema(schema.additionalProperties, value[key], depth + 1) : true));
  }
  return true;
}

// Local format checks run before discovery, files, preflight reads or writes.
// Domain validation, live policy and revisions are still checked by the handler/RPC.
export function validateCLIParameters(args, entry) {
  const parameters = syntaxParameters(entry), seen = new Set(), positional = [];
  for (let index = entry.path.split(' ').length; index < args.length; index++) {
    const value = args[index];
    if (!isOptionIndex(args, index) || !value.startsWith('-')) { positional.push(value); continue; }
    const spec = parameters.options[value];
    requireValue(spec, `unknown option ${value}; run help ${entry.path}`);
    requireValue(!seen.has(value) || spec.repeatable, `duplicate option ${value}`); seen.add(value);
    if (spec.arity === 0) continue;
    const raw = args[++index];
    requireValue(raw !== undefined && isOptionIndex(args, index) && !raw.startsWith('--'), `${value} requires a value`);
    if (spec.enum) requireValue(spec.enum.includes(['integer','number'].includes(spec.type) ? Number(raw) : raw), `${value} expects ${spec.enum.join('|')}`);
    if (['integer','number'].includes(spec.type)) {
      requireValue(/^(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw)), `${value} expects a nonnegative safe integer`);
      requireValue((spec.minimum === undefined || Number(raw) >= spec.minimum) && (spec.maximum === undefined || Number(raw) <= spec.maximum), `${value} is outside its allowed range`);
    }
    if (spec.type === 'boolean' && spec.arity !== 0) requireValue(['true','false'].includes(raw), `${value} expects true|false`);
    if (spec.type === 'json' || value === '--data' || value === '--questions-json') {
      requireValue(Buffer.byteLength(raw) <= (spec.maxBytes ?? 40000), 'inline JSON exceeds budget');
      let payload; try { payload = JSON.parse(raw); } catch { throw cliParameterError(`${value} expects valid JSON`); }
      if (spec.schema) requireValue(matchesJSONSchema(spec.schema, payload), `${value} does not match its CLI payload schema; read leaf help`);
    } else {
      const scalar = spec.schema ?? spec;
      requireValue(matchesCLIValue(scalar, raw), `${value} does not match its CLI value contract`);
    }
  }
  for (const [flag, definition] of Object.entries(parameters.options)) if (definition.required) requireValue(seen.has(flag), `missing ${flag}`);
  for (const group of parameters.mutuallyExclusive ?? []) requireValue(group.filter(flag => seen.has(flag)).length <= 1, `conflicting options: ${group.join(', ')}`);
  // Explicit positional declarations are authoritative. Inferred legacy contracts
  // remain handler-validated during the atomic catalogue replacement.
  if (parameters.positional_validation) {
    const specs = parameters.positionals;
    requireValue(positional.length >= specs.filter(item => item.required).length, `missing arguments; run help ${entry.path}`);
    requireValue(specs.some(item => item.repeatable || item.variadic) || positional.length <= specs.length, `too many arguments; run help ${entry.path}`);
    for (let index = 0; index < positional.length; index++) {
      const spec = specs[Math.min(index, specs.length - 1)];
      if (spec) requireValue(matchesCLIValue(spec.schema ?? spec, positional[index]), `${spec.name} does not match its CLI value contract`);
    }
  }
  return { parameters, positional };
}
