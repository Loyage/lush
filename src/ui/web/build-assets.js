// Isolated Bun builder: startWeb remains synchronous. No project paths/data enter this process.
import fs from 'node:fs';
import path from 'node:path';

export async function buildAssets(assets, outdir, version) {
  const naming = `web-${version}-[name]-[hash].[ext]`;
  const result = await Bun.build({
    entrypoints: [path.join(assets, 'app.js'), path.join(assets, 'appearance.js')],
    outdir, target: 'browser', format: 'esm', splitting: true,
    minify: true, sourcemap: 'none', naming: { entry: naming, chunk: naming, asset: naming },
  });
  if (!result.success) throw new AggregateError(result.logs, 'Web asset build failed');
  const entries = {};
  for (const output of result.outputs) {
    if (output.kind !== 'entry-point') continue;
    const name = path.basename(output.path);
    if (name.startsWith(`web-${version}-app-`)) entries.app = name;
    if (name.startsWith(`web-${version}-appearance-`)) entries.appearance = name;
  }
  if (!entries.app || !entries.appearance) throw new Error('Missing Web entry points');
  let html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  // Inline only stylesheet imports, not style tags: CSP and cascade order stay unchanged.
  const cssStack = new Set();
  const readCss = name => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.css$/.test(name) || cssStack.has(name)) throw new Error('Unsafe/cyclic CSS import');
    cssStack.add(name);
    const css = fs.readFileSync(path.join(assets, name), 'utf8').replace(/@import\s+url\(['"]?\.\/([^'"\)]+)['"]?\)\s*;/g,
      (_, imported) => readCss(imported));
    cssStack.delete(name);
    return `/* ${name} */\n${css}\n`;
  };
  let css = '';
  const cssName = `web-${version}-styles.css`;
  html = html.replace(/<link rel="stylesheet" href="\/([^"\n]+)">/g, (_, name) => {
    const first = !css;
    css += readCss(name);
    return first ? `<link rel="stylesheet" href="/${cssName}">` : '';
  });
  fs.writeFileSync(path.join(outdir, cssName), css);
  html = html.replace('/appearance.js', `/${entries.appearance}`).replace('/app.js', `/${entries.app}`);
  // Bun can produce several shared chunks. Preload only the static startup closure,
  // avoiding serial network waterfalls without fetching dynamically opened pages.
  const seen = new Set(), pending = [entries.app, entries.appearance];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = fs.readFileSync(path.join(outdir, name), 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']\.\/([^"']+)["']/g)) pending.push(match[1]);
  }
  const preloads = [...seen].filter(name => name !== entries.app && name !== entries.appearance)
    .map(name => `<link rel="modulepreload" href="/${name}">`).join('\n');
  html = html.replace('</head>', `${preloads}\n</head>`);
  fs.writeFileSync(path.join(outdir, 'index.html'), html);
}

if (import.meta.main) await buildAssets(process.argv[2], process.argv[3], process.argv[4]);
