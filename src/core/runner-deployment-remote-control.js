// Self-contained, serialized with the trusted launcher/recovery program. No JSON
// option creates/adopts a lease; identities were bound by original configure.
export async function runtimeControl(m, { mode = 'normal', held_fd = null, recovery_id = null, generation_sha256 = null } = {}) {
  const fs = await import('node:fs'), crypto = await import('node:crypto');
  const assert = (v, code = 'identity_changed') => { if (!v) throw Object.assign(new Error('Managed execution gate refused'), { code }); };
  const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
  const ident = s => `${s.dev}:${s.ino}`, hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const names = { lease: 'connection-lease', activity_lock: 'activity-lock', epoch: 'activity-epoch', gate: 'recovery-gate', recoveries: 'recoveries', generations: 'runtime-generations', workspaces: 'workspaces', config: 'config.json' };
  assert(m.control && Object.keys(names).every(k => /^[0-9]+:[0-9]+$/.test(m.control[k])));
  const directory = absolute => {
    let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { for (const part of absolute.slice(1).split('/')) { assert(/^[A-Za-z0-9_.+-]+$/.test(part) && !['.', '..'].includes(part)); const n = fs.openSync(`/proc/self/fd/${fd}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW), s = fs.fstatSync(n); if (!([0, m.target.uid].includes(s.uid) && ((s.mode & 0o022) === 0 || s.uid === 0 && (s.mode & 0o1777) === 0o1777))) { fs.closeSync(n); assert(false); } fs.closeSync(fd); fd = n; } return fd; }
    catch (e) { fs.closeSync(fd); throw e; }
  };
  let root, lease, lib; const extra = new Set();
  const close = () => { for (const fd of extra) fs.closeSync(fd); extra.clear(); if (held_fd === null && lease !== undefined) fs.closeSync(lease); if (lib) lib.close(); if (root !== undefined) fs.closeSync(root); root = undefined; };
  try {
    root = directory(m.install_root); assert(ident(fs.fstatSync(root)) === m.root_identity && (fs.fstatSync(root).mode & 0o7777) === 0o700);
    const checked = (name, directory = false, writable = false) => {
      const fd = fs.openSync(`/proc/self/fd/${root}/${name}`, (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW | (directory ? fs.constants.O_DIRECTORY : 0));
      const s = fs.fstatSync(fd); if (!(s.uid === m.target.uid && (s.mode & 0o7777) === (directory ? 0o700 : 0o600) && (directory ? s.isDirectory() : s.isFile() && s.nlink === 1))) { fs.closeSync(fd); assert(false); } return fd;
    };
    for (const [k, n] of Object.entries(names)) { const fd = checked(n, ['recoveries', 'generations', 'workspaces'].includes(k)); try { assert(ident(fs.fstatSync(fd)) === m.control[k]); } finally { fs.closeSync(fd); } }
    lease = held_fd === null ? checked(names.lease) : held_fd; assert(ident(fs.fstatSync(lease)) === m.control.lease);
    if (held_fd === null) { const ffi = await import('bun:ffi'); lib = ffi.dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' } }); assert(lib.symbols.flock(lease, (['normal', 'provisional'].includes(mode) ? 1 : 2) | 4) === 0, 'busy'); }
    const checkpoint=()=>{const fd=directory(m.install_root);try{assert(ident(fs.fstatSync(fd))===m.root_identity);}finally{fs.closeSync(fd);}for(const [k,n]of Object.entries(names)){const f=checked(n,['recoveries','generations','workspaces'].includes(k));try{assert(ident(fs.fstatSync(f))===m.control[k]);}finally{fs.closeSync(f);}}};
    const path = name => { assert(/^(?:recoveries\/[a-f0-9-]{36}\/[A-Za-z0-9_.-]+|runtime-generations\/[a-f0-9-]{36}\.json|activity-epoch|recovery-gate)$/.test(name)); return name; };
    const parent = name => {
      checkpoint(); path(name); const parts = name.split('/'), base = parts.pop(); let fd = fs.openSync(`/proc/self/fd/${root}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { for (const part of parts) { const n = fs.openSync(`/proc/self/fd/${fd}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW), s = fs.fstatSync(n); if (!(s.uid === m.target.uid && (s.mode & 0o7777) === 0o700)) { fs.closeSync(n); assert(false); } fs.closeSync(fd); fd = n; } return { fd, base }; } catch(e) { fs.closeSync(fd); throw e; }
    };
    const read = (name, limit = 262144) => {
      const p = parent(name); let fd;
      try { fd = fs.openSync(`/proc/self/fd/${p.fd}/${p.base}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd); assert(s.isFile() && s.uid === m.target.uid && (s.mode & 0o7777) === 0o600 && s.nlink === 1 && s.size <= limit); const b = fs.readFileSync(fd); assert(b.length === s.size && ident(fs.lstatSync(`/proc/self/fd/${p.fd}/${p.base}`)) === ident(s)); return b; }
      finally { if(fd !== undefined) fs.closeSync(fd); fs.closeSync(p.fd); }
    };
    const optional = name => { try { return read(name); } catch(e) { if (e.code === 'ENOENT') return null; throw e; } };
    const write = (name, value) => {
      assert(!['normal', 'inspect', 'check'].includes(mode), 'config_invalid'); const p = parent(name); let fd;
      try { fd = fs.openSync(`/proc/self/fd/${p.fd}/${p.base}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.fsyncSync(p.fd); }
      finally { if(fd !== undefined) fs.closeSync(fd); fs.closeSync(p.fd); }
    };
    const update = (name, value) => {
      checkpoint(); assert(['activity-epoch', 'recovery-gate'].includes(name)); const fd = checked(name, false, true);
      try { assert(ident(fs.fstatSync(fd)) === m.control[name === 'activity-epoch' ? 'epoch' : 'gate']); fs.writeSync(fd, value, 0, 'utf8'); fs.ftruncateSync(fd, Buffer.byteLength(value)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    const gate = read('recovery-gate', 64).toString().trimEnd(), epoch = () => { const n = read('activity-epoch', 64).toString().trimEnd(); assert(/^(?:0|[1-9][0-9]{0,14})$/.test(n)); return n; };
    const published = () => {
      assert(read('recovery-gate',64).toString()===gate+'\n');
      if (gate === 'none') { assert(!m.runtime_generation); return null; }
      const g = m.runtime_generation; assert(g && g.recovery_id === gate && /^[a-f0-9]{64}$/.test(g.sha256) && /^[a-f0-9-]{36}$/.test(g.publication_id));
      assert(read(`recoveries/${gate}/activated`, 256).toString() === `${gate}:${g.sha256}:${g.publication_id}\n`, 'recovery_blocked');
      const bytes = read(`runtime-generations/${gate}.json`); assert(hash(bytes) === g.sha256 && stable(JSON.parse(bytes)) === stable(g.generation)); return g.generation;
    };
    let generation = null;
    if (['normal', 'check'].includes(mode) || mode==='apply' && gate!==recovery_id) generation = published();
    if (mode === 'normal' && held_fd === null) {
      const fd = checked(names.activity_lock); extra.add(fd); assert(lib.symbols.flock(fd, 6) === 0, 'busy'); update('activity-epoch', String(BigInt(epoch()) + 1n) + '\n'); fs.closeSync(fd); extra.delete(fd);
    }
    if (mode === 'provisional') {
      assert(gate === recovery_id && /^[a-f0-9]{64}$/.test(generation_sha256), 'recovery_blocked'); const bytes = read(`recoveries/${recovery_id}/candidate.json`); assert(hash(bytes) === generation_sha256); generation = JSON.parse(bytes);
      const marker=`recoveries/${recovery_id}/verification.started`, ticket=`${recovery_id}:${generation_sha256}\n`;
      if(held_fd===null) write(marker,ticket);
      else {assert(read(marker,256).toString()===ticket);assert(ident(fs.fstatSync(6))===ident(fs.lstatSync(`/proc/self/fd/${root}/${marker}`)));}
    }
    return { root, read, optional, write, epoch, gate, generation, close, checkpoint, setGate(id) { assert(mode === 'apply' && /^[a-f0-9-]{36}$/.test(id)); update('recovery-gate', id + '\n'); }, mkdir(id) { checkpoint(); assert(mode === 'apply' && /^[a-f0-9-]{36}$/.test(id)); const fd = checked('recoveries', true); try { fs.mkdirSync(`/proc/self/fd/${fd}/${id}`, {mode:0o700}); fs.fsyncSync(fd); } finally {fs.closeSync(fd);} } };
  } catch(e) {close(); throw e;}
}

// This runs in the login shell BEFORE uploaded Bun executes. The inherited FD8
// lease spans the complete managed process; FD7 serializes short epoch updates.
export function controlShell(m, admission = { mode: 'normal' }) {
  const q = s => `'${String(s).replace(/'/g, `'"'"'`)}'`;
  if (!m.control) throw new Error('Managed execution lease is unavailable');
  const { mode, recovery_id, generation_sha256 } = admission;
  if (!['normal', 'provisional', 'check', 'apply', 'inspect', 'seal', 'activate'].includes(mode)) throw new Error('Invalid managed admission');
  if(mode==='provisional' && (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(recovery_id)||!/^[a-f0-9]{64}$/.test(generation_sha256)))throw new Error('Invalid recovery verification admission');
  const normal = m.runtime_generation;
  const allowed = normal ? `${normal.recovery_id}:${normal.sha256}:${normal.publication_id}` : null;
  const privateFile=name=>`[ -f ${q(name)} ] && [ ! -L ${q(name)} ] && [ "$(stat -c '%u:%a:%h' ${q(name)})" = ${q(`${m.target.uid}:600:1`)} ]`;
  const privateDirectory=name=>`[ -d ${q(name)} ] && [ ! -L ${q(name)} ] && [ "$(stat -c '%u:%a' ${q(name)})" = ${q(`${m.target.uid}:700`)} ]`;
  return `
[ "$(stat -Lc '%u:%a:%d:%i' .)" = ${q(`${m.target.uid}:700:${m.root_identity}`)} ]
[ -f /usr/bin/flock ] && [ "$(stat -Lc '%u' /usr/bin/flock)" = 0 ]
case "$(stat -Lc '%a' /usr/bin/flock)" in [4567][0145][0145]) ;; *) exit 41;; esac
${Object.entries({lease:'connection-lease',activity_lock:'activity-lock',epoch:'activity-epoch',gate:'recovery-gate',recoveries:'recoveries',generations:'runtime-generations',workspaces:'workspaces',config:'config.json'}).map(([k,n])=>`[ ! -L ${q(n)} ] && [ "$(stat -c '%u:%a:%d:%i' ${q(n)})" = ${q(`${m.target.uid}:${['recoveries','generations','workspaces'].includes(k)?700:600}:${m.control[k]}`)} ]`).join('\n')}
for file in connection-lease activity-lock activity-epoch recovery-gate config.json; do [ -f "$file" ] && [ "$(stat -c '%h' "$file")" = 1 ] || exit 41; done
exec 8< ./connection-lease
/usr/bin/flock ${['normal','provisional'].includes(mode)?'-s':'-x'} -n 8
[ "$(stat -Lc '%d:%i' /proc/self/fd/8)" = ${q(m.control.lease)} ]
gate=$(head -c 65 ./recovery-gate)
${mode==='normal'||mode==='check' ? normal ? `[ "$gate" = ${q(normal.recovery_id)} ] && [ "$(wc -c < ./recovery-gate)" -eq 37 ]
${privateDirectory(`recoveries/${normal.recovery_id}`)}
${privateFile(`recoveries/${normal.recovery_id}/activated`)}
[ "$(wc -c < ${q(`recoveries/${normal.recovery_id}/activated`)})" -eq ${Buffer.byteLength(allowed)+1} ]
[ "$(head -c 257 ${q(`recoveries/${normal.recovery_id}/activated`)})" = ${q(allowed)} ]
${privateFile(`runtime-generations/${normal.recovery_id}.json`)}
[ "$(sha256sum ${q(`runtime-generations/${normal.recovery_id}.json`)} | cut -d ' ' -f 1)" = ${q(normal.sha256)} ]` : `[ "$gate" = none ] && [ "$(wc -c < ./recovery-gate)" -eq 5 ]` : mode==='provisional' ? `[ "$gate" = ${q(recovery_id)} ] && [ "$(wc -c < ./recovery-gate)" -eq 37 ]
${privateDirectory(`recoveries/${recovery_id}`)}
${privateFile(`recoveries/${recovery_id}/candidate.json`)}
[ "$(sha256sum ${q(`recoveries/${recovery_id}/candidate.json`)} | cut -d ' ' -f 1)" = ${q(generation_sha256)} ]
(umask 077; set -C; printf '%s\\n' ${q(`${recovery_id}:${generation_sha256}`)} > ${q(`recoveries/${recovery_id}/verification.started`)})
sync -d ${q(`recoveries/${recovery_id}/verification.started`)} ${q(`recoveries/${recovery_id}`)}
exec 6< ${q(`recoveries/${recovery_id}/verification.started`)}` : ''}
${mode==='normal' ? `exec 7< ./activity-lock
/usr/bin/flock -x -n 7
n=$(head -c 65 ./activity-epoch)
case "$n" in ''|*[!0-9]*|0[0-9]*) exit 41;; esac
[ "\${#n}" -le 15 ]
n=$((n+1)); printf '%s\\n' "$n" > ./activity-epoch
sync -d ./activity-epoch
/usr/bin/flock -u 7
exec 7<&-
` : ''}`.split('\n').map(line=>line.trimStart().startsWith('[')?line+' || exit 41':line).join('\n');
}
