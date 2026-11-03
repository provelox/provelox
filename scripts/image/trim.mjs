// Run once while the platform image is assembled (see the Dockerfile): takes out what the running image never reads.
// Nothing here changes behaviour; each step says why.
//   node trim.mjs /app
import {
  lstatSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: node trim.mjs <dir>');

const walk = (dir, visit) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (visit(p, name, st) === false) continue;
    if (st.isDirectory()) walk(p, visit);
  }
};
const rm = (p) => rmSync(p, { recursive: true, force: true });
const before = () => {
  let n = 0;
  walk(root, (_p, _n, st) => void (st.isFile() && (n += st.size)));
  return n;
};
const start = before();

// 1. sharp (and its native libvips) is what Next uses to resize pictures for /_next/image. The console does not use
//    that route: its one next/image is `unoptimized`, and next.config sets images.unoptimized.
rm(join(root, 'console', 'node_modules', '@img'));
rm(join(root, 'console', 'node_modules', 'sharp'));

// 2. better-sqlite3 ships a binary for every system and the SQLite source it can be built from. This image runs one
//    system (glibc Linux, this build's CPU), and loads prebuilds/<platform>-<arch>.node by name.
const keep = `${process.platform}-${process.arch}.node`;
{
  const dir = join(root, 'node_modules', 'better-sqlite3');
  try {
    for (const f of readdirSync(join(dir, 'prebuilds')))
      if (f !== keep) rm(join(dir, 'prebuilds', f));
    for (const f of ['deps', 'src', 'build', 'binding.gyp']) rm(join(dir, f));
  } catch {
    // not installed there
  }
}

// 3. Files that are read by editors and compilers, never by node at run time. Licences stay.
const KEEP = /^(licen[cs]e|notice|copying)/i;
walk(root, (p, name, st) => {
  if (st.isDirectory()) {
    if (name === '@types') return void rm(p), false;
    return true;
  }
  if (
    /\.(map|d\.ts|d\.mts|d\.cts)$/.test(name) ||
    (/\.md$/i.test(name) && !KEEP.test(name))
  )
    rm(p);
  return true;
});

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`trim: ${mb(start)} MB -> ${mb(before())} MB`);
