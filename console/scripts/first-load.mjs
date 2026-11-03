#!/usr/bin/env node
// The client JavaScript each route loads on first visit (the chunks its client modules need, plus the shared runtime),
// raw and gzipped, read from a finished `next build`:
//
//   npm run build && npm run first-load            # a table of the main routes
//   npm run first-load -- --all                    # every route
//
// For what is inside those bytes, run `npm run analyze` (Next's own bundle analyzer, an interactive page).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const next = join(resolve(process.cwd()), '.next');
const all = process.argv.includes('--all');
const MAIN = [
  '/',
  '/login',
  '/apps',
  '/apps/[name]',
  '/apps/[name]/networking',
  '/apps/[name]/configuration',
  '/apps/[name]/logs',
  '/collections/[id]',
  '/projects/[name]',
  '/settings',
  '/templates',
];

const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
const manifests = walk(join(next, 'server/app')).filter((f) =>
  f.endsWith('page_client-reference-manifest.js'),
);

const sizes = new Map();
const sizeOf = (chunk) => {
  const file = join(next, chunk.replace(/^\/_next\//, '').replace(/\?.*$/, ''));
  if (!sizes.has(file)) {
    try {
      const buf = readFileSync(file);
      sizes.set(file, { raw: buf.length, gz: gzipSync(buf).length });
    } catch {
      sizes.set(file, { raw: 0, gz: 0 });
    }
  }
  return sizes.get(file);
};

const bm = JSON.parse(readFileSync(join(next, 'build-manifest.json'), 'utf8'));
const shared = [...(bm.rootMainFiles ?? []), ...(bm.polyfillFiles ?? [])].map(
  (f) => '/_next/' + f.replace(/^\//, ''),
);

const rows = manifests.map((m) => {
  const text = readFileSync(m, 'utf8');
  const route =
    text
      .match(/__RSC_MANIFEST\["([^"]+)"\]/)[1]
      .replace('/(dashboard)', '')
      .replace(/\/page$/, '') || '/';
  const json = JSON.parse(
    text.slice(text.indexOf('= {') + 2).replace(/;\s*$/, ''),
  );
  const chunks = new Set(shared);
  for (const mod of Object.values(json.clientModules ?? {}))
    for (const c of mod.chunks ?? [])
      if (/\.js(\?|$)/.test(c))
        chunks.add(
          c.startsWith('/_next') ? c : '/_next/' + c.replace(/^\//, ''),
        );
  let raw = 0;
  let gz = 0;
  for (const c of chunks) {
    const s = sizeOf(c);
    raw += s.raw;
    gz += s.gz;
  }
  return { route, raw, gz, chunks: chunks.size };
});

rows.sort((a, b) => b.gz - a.gz);
const kb = (n) => (n / 1024).toFixed(0).padStart(5);
console.log('route'.padEnd(36), ' raw KB  gzip KB  chunks');
for (const r of rows.filter((r) => all || MAIN.includes(r.route)))
  console.log(
    r.route.padEnd(36),
    kb(r.raw),
    '   ',
    kb(r.gz),
    '   ',
    String(r.chunks).padStart(3),
  );
const gz = rows.map((r) => r.gz).sort((a, b) => a - b);
console.log(
  `${rows.length} routes, median ${kb(gz[Math.floor(gz.length / 2)]).trim()} KB gzipped`,
);
