import { createHash } from 'node:crypto';

const MAX_ARGUMENT_CHARS = 256 * 1024;
const preview = (text, max) => ({ text: text.slice(0, max), truncated: text.length > max });

/** Canonical JSON changes key order only: command whitespace, paths and every argument remain significant. */
function canonical(value, state, depth = 0) {
  if (++state.nodes > 16000 || depth > 32) throw new Error('analysis_limit');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, state, depth + 1)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], state, depth + 1)}`).join(',')}}`;
}

/** Authenticated transcript metadata only; never execute, normalize shell syntax or hash a clipped preview. */
export function transcriptShell(step) {
  if (step.kind !== 'tool' || (step.tool_name || step.title) !== 'bash') return null;
  const body = typeof step.body === 'string' ? step.body : '';
  const unavailable = reason => ({ command: '', command_length: null, command_truncated: false,
    parameters: '', parameters_truncated: false, fingerprint: null, identity_complete: false, reason });
  if (body.length > MAX_ARGUMENT_CHARS) return unavailable('analysis_limit');
  let args;
  try { args = JSON.parse(body); } catch { return unavailable('invalid_arguments'); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.command !== 'string' || !args.command.length) return unavailable('missing_command');
  const command = preview(args.command, 2048);
  try {
    const encoded = canonical(args, { nodes: 0 });
    const parameters = preview(canonical(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'command')), { nodes: 0 }), 1024);
    return { command: command.text, command_length: args.command.length, command_truncated: command.truncated,
      parameters: parameters.text, parameters_truncated: parameters.truncated, identity_complete: true,
      fingerprint: createHash('sha256').update('bash\0').update(encoded).digest('hex') };
  } catch {
    return { ...unavailable('analysis_limit'), command: command.text, command_length: args.command.length, command_truncated: command.truncated };
  }
}
