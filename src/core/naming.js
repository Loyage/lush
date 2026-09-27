import { check } from './types.js';

/** Long enough to identify the work, short enough to read in `git branch` and the Web UI. */
const MAX_LENGTH = 40;
/** Words that carry no task identity; dropped only when falling back to the goal text. */
const STOPWORDS = new Set(['the','a','an','and','or','of','to','for','in','on','at','by','with','from','into',
  'that','this','is','are','be','been','not','no','do','does','did','as','it','its','if','then','than','so','but',
  'all','any','can','could','will','would','should','must','may','might','use','using','via','per','new','get','set',
  'task','goal','lush','work','change','changes','update','updates','implement','implementation']);

/** Lowercase ASCII words joined by '-': the only shape a git ref accepts without quoting. */
export function slugify(value, max = MAX_LENGTH) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 8).join('-')
    .slice(0, max).replace(/-+$/g, '');
}

/** Planner-supplied short name, else the goal's first meaningful ASCII words; null means "no usable name". */
export function taskSlug(name, goal) {
  if (name !== null && name !== undefined && name !== '') {
    check(typeof name === 'string', 'name must be text');
    check(name.length <= 200, 'name must be at most 200 characters');
    const slug = slugify(name);
    check(slug.length >= 2, `name needs at least two ASCII letters or digits (kebab-case), e.g. fix-login-composer; got ${JSON.stringify(name)}`);
    return slug;
  }
  return goalSlug(goal);
}

function goalSlug(goal) {
  const words = String(goal).split('\n')[0].match(/[A-Za-z][A-Za-z0-9]*/g) || [];
  const kept = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOPWORDS.has(lower) || kept.includes(lower)) continue;
    kept.push(lower);
    if (kept.length === 4) break;
  }
  return kept.length ? slugify(kept.join('-')) || null : null;
}

/** `<id>-<slug>`: the id keeps names unique and greppable, the slug says what the task is. */
export function taskLabel(id, name) {
  return name ? `${id}-${name}` : `task-${id}`;
}

/** `input-<id>`: 输入锚点的分支与检出目录名。输入没有 slug，id 已经唯一且可读。 */
export function inputLabel(id) { return `input-${id}`; }
