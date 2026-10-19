import { check } from '../../core/types.js';
import { listCapabilityGuides, capabilityGuide } from '../../agent/capabilities.js';

/** Code-owned public guides, not a device config read or Agent permission bypass. */
export async function run(_command, args, { json = false } = {}) {
  const [verb, id, ...extra] = args;
  check(extra.length === 0, 'invalid skills arguments; use lushw skills list|show ID');
  let value;
  if (verb === 'list') {
    check(id === undefined, 'skills list takes no arguments');
    value = listCapabilityGuides();
    if (json) return value;
    for (const entry of value) console.log(`${entry.id}\t${entry.title}\t${entry.description}`);
  } else if (verb === 'show') {
    check(typeof id === 'string' && id.length > 0, 'skills show requires a built-in skill ID');
    value = capabilityGuide(id);
    if (json) return value;
    console.log(value.content);
  } else throw new Error('unknown skills command; use lushw skills list|show ID');
  return undefined;
}
