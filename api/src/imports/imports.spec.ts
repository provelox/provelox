import {
  DELETE_SCRIPT,
  DISCARD_PART_SCRIPT,
  ENSURE_SCRIPT,
  EXPORT_SCRIPT,
  FINISH_PART_SCRIPT,
  IMPORTS_LISTED,
  LIST_SCRIPT,
  READ_FILE_SCRIPT,
  REPLACE_FROM_SCRIPT,
  RESTORE_FROM_SCRIPT,
  WRITE_PART_SCRIPT,
  exportFileName,
  importKind,
  isImportName,
  parseListing,
} from './imports';

describe('importKind: which files are for a volume and which for a database', () => {
  it.each([
    ['shop-data-20261102-210509.tar.gz', 'volume'],
    ['a.tgz', 'volume'],
    ['db-20261102-010203.dump', 'database'],
    ['export.sql', 'database'],
    ['export.sql.gz', 'database'],
    // a dump that is also archived is still an archive: the last ending decides
    ['db.dump.tar.gz', 'volume'],
    ['db.sql.tgz', 'volume'],
  ] as const)('%s is for a %s', (n, kind) => expect(importKind(n)).toBe(kind));

  it.each([
    'a.gz',
    'a.sql.zip',
    'a.dump.exe',
    'a.DUMP',
    'a.SQL',
    '.dump',
    '.sql',
    '../x.dump',
    'a/b.sql',
    '.hidden.sql.gz',
    'a b.dump',
    'a;rm.sql',
    '',
  ])('%j is for neither', (n) => expect(importKind(n)).toBeNull());
});

describe('isImportName', () => {
  it.each([
    'shop-data-20261102-210509.tar.gz',
    'a.tgz',
    'backup_1.2.tar.gz',
    'A1.tar.gz',
    'db-1.dump',
    'x.sql',
    'x.sql.gz',
  ])('accepts %s', (n) => expect(isImportName(n)).toBe(true));

  it.each([
    // paths and traversal
    '../etc/passwd.tar.gz',
    '..tar.gz',
    'a..b.tar.gz',
    '/etc/x.tar.gz',
    'dir/x.tar.gz',
    'dir\\x.tar.gz',
    '.hidden.tar.gz',
    '-rf.tar.gz',
    '../etc/passwd.dump',
    'a..b.sql',
    '/etc/x.sql.gz',
    // wrong ending
    'a.tar',
    'a.zip',
    'a.gz',
    'a.TAR.GZ',
    'a.tar.gz.exe',
    'tgz',
    '.tgz',
    // characters a shell or a path could take apart
    'a b.tar.gz',
    'a;b.tar.gz',
    'a$(x).tar.gz',
    'a`x`.tar.gz',
    'a\nb.tar.gz',
    "a'b.tar.gz",
    'a%2fb.tar.gz',
    '',
    `${'a'.repeat(129)}.tar.gz`,
  ])('refuses %j', (n) => expect(isImportName(n)).toBe(false));

  it('refuses what is not a string', () => {
    for (const v of [undefined, null, 5, {}, ['a.tgz']])
      expect(isImportName(v)).toBe(false);
  });
});

describe('exportFileName', () => {
  const now = new Date('2026-11-02T21:05:09.123Z');
  it('names the app, the volume and the time, and is always a valid name', () => {
    expect(exportFileName('shop', 'data', now)).toBe(
      'shop-data-20261102-210509.tar.gz',
    );
    for (const [a, v] of [
      ['a'.repeat(100), 'b'.repeat(100)],
      ['.x', '-y'],
      ['we ird/app', 'v;ol'],
    ])
      expect(isImportName(exportFileName(a, v, now))).toBe(true);
  });
});

describe('parseListing', () => {
  const out = [
    'F\ta.tar.gz\t1000\t1700000000\t1',
    'F\tb.tgz\t5\t1800000000\t0',
    'F\t../evil.tar.gz\t5\t1800000000\t1',
    'F\tnot-an-archive.txt\t5\t1800000000\t1',
    'F\tc.tar.gz\tNaN\t1700000000\t1',
    'F\td.tar.gz\t1\t2\t1\textra',
    'F\te.tar.gz\t\t\t1',
    'garbage',
    'D\t2048',
  ].join('\n');

  it('keeps valid files, newest first, with the free space', () => {
    const l = parseListing(out, '/var/lib/provelox/imports');
    expect(l.dir).toBe('/var/lib/provelox/imports');
    expect(l.files.map((f) => f.name)).toEqual(['b.tgz', 'a.tar.gz']);
    expect(l.files[0]).toEqual({
      name: 'b.tgz',
      sizeBytes: 5,
      modifiedAt: new Date(1800000000 * 1000).toISOString(),
      gzip: false,
      kind: 'volume',
    });
    expect(l.files[1].gzip).toBe(true);
    expect(l.freeBytes).toBe(2048 * 1024);
  });

  it('lists dumps beside archives, each with the kind its name says', () => {
    const l = parseListing(
      [
        'F\tapp-1.dump\t10\t1700000001\t0',
        'F\tapp-2.sql.gz\t11\t1700000002\t1',
        'F\tapp-3.sql\t12\t1700000003\t0',
        'F\tvol.tar.gz\t13\t1700000004\t1',
        'F\t.app-4.dump.part\t14\t1700000005\t0',
        'D\t1',
      ].join('\n'),
      '/d',
    );
    expect(l.files.map((f) => [f.name, f.kind])).toEqual([
      ['vol.tar.gz', 'volume'],
      ['app-3.sql', 'database'],
      ['app-2.sql.gz', 'database'],
      ['app-1.dump', 'database'],
    ]);
  });

  it('has no free space reading when the disk line is missing or unreadable', () => {
    expect(parseListing('', '/d').freeBytes).toBeNull();
    expect(parseListing('D\t\n', '/d').freeBytes).toBeNull();
    expect(parseListing('D\tabc\n', '/d').freeBytes).toBeNull();
  });

  it('lists at most the newest 200', () => {
    const lines = Array.from(
      { length: 250 },
      (_, i) => `F\tf${i}.tar.gz\t1\t${1000 + i}\t1`,
    );
    const l = parseListing(lines.join('\n'), '/d');
    expect(l.files).toHaveLength(IMPORTS_LISTED);
    expect(l.files[0].name).toBe('f249.tar.gz');
  });
});

describe('the helper programs', () => {
  const all = {
    ENSURE_SCRIPT,
    LIST_SCRIPT,
    EXPORT_SCRIPT,
    RESTORE_FROM_SCRIPT,
    REPLACE_FROM_SCRIPT,
    DELETE_SCRIPT,
    WRITE_PART_SCRIPT,
    FINISH_PART_SCRIPT,
    DISCARD_PART_SCRIPT,
    READ_FILE_SCRIPT,
  };

  it('take a file name only as the argument $1, in quotes, never as part of the text', () => {
    for (const [name, text] of Object.entries(all)) {
      // every use of the argument is the quoted "$1" (or inside a quoted path built from it)
      const uses = text.match(/\$1/g) ?? [];
      const quoted = text.match(/"[^"\n]*\$1[^"\n]*"/g) ?? [];
      expect(uses.length).toBe(
        quoted.reduce((n, q) => n + (q.match(/\$1/g) ?? []).length, 0),
      );
      // nothing a caller could send is in the text: only fixed paths and fixed words
      expect(text).not.toMatch(/\$\{|`/);
      expect(name).toBeTruthy();
    }
  });

  it('refuse anything but a bare file name before doing anything else', () => {
    for (const text of [
      EXPORT_SCRIPT,
      RESTORE_FROM_SCRIPT,
      REPLACE_FROM_SCRIPT,
      DELETE_SCRIPT,
      WRITE_PART_SCRIPT,
      FINISH_PART_SCRIPT,
      DISCARD_PART_SCRIPT,
      READ_FILE_SCRIPT,
    ])
      expect(text.startsWith('case "$1" in ""|*/*|.*)')).toBe(true);
  });

  it('save a dump under a hidden name, and only FINISH makes it appear, never over an existing file', () => {
    // the part file starts with a dot, so the listing patterns never match it
    expect(WRITE_PART_SCRIPT).toContain('tmp="/imports/.$1.part"');
    expect(WRITE_PART_SCRIPT).toContain('cat > "$tmp"');
    expect(WRITE_PART_SCRIPT).not.toContain('mv ');
    expect(WRITE_PART_SCRIPT).toContain('exit 5');
    expect(FINISH_PART_SCRIPT).toContain('mv "$tmp" "/imports/$1"');
    expect(FINISH_PART_SCRIPT).toContain('[ -e "/imports/$1" ]');
    expect(DISCARD_PART_SCRIPT).toContain('rm -f -- "/imports/.$1.part"');
    for (const part of ['*.dump', '*.sql.gz', '*.sql'])
      expect(LIST_SCRIPT).toContain(part);
  });

  it('read a dump only if it is a plain file, and write nothing', () => {
    expect(READ_FILE_SCRIPT).toContain('[ ! -L "$f" ]');
    expect(READ_FILE_SCRIPT).toContain('exec cat -- "$f"');
    // redirections other than the error messages to stderr, and any removal or move
    expect(READ_FILE_SCRIPT.replace(/>&2/g, '')).not.toMatch(/>|rm |mv /);
  });

  it('check that the file is a plain gzip file before the volume is emptied', () => {
    const replace = REPLACE_FROM_SCRIPT;
    const guard = replace.indexOf('1f8b');
    const wipe = replace.indexOf('find /data -mindepth 1 -delete');
    expect(guard).toBeGreaterThan(0);
    expect(wipe).toBeGreaterThan(guard);
    expect(replace).toContain('[ ! -L "$f" ]');
    expect(RESTORE_FROM_SCRIPT).not.toContain('-delete');
  });

  it('write a copy under a hidden name and move it in only when tar is done', () => {
    expect(EXPORT_SCRIPT).toContain('tmp="/imports/.$1.part"');
    expect(EXPORT_SCRIPT.indexOf('mv "$tmp"')).toBeGreaterThan(
      EXPORT_SCRIPT.indexOf('tar -c'),
    );
    expect(EXPORT_SCRIPT).toContain('rm -f "$tmp"');
    // busybox tar says 1 for a full disk too: the file is only kept when it reads to the end
    expect(EXPORT_SCRIPT).toContain('gzip -t "$tmp"');
    expect(EXPORT_SCRIPT.indexOf('gzip -t')).toBeLessThan(
      EXPORT_SCRIPT.indexOf('mv "$tmp"'),
    );
    // an existing file is never overwritten
    expect(EXPORT_SCRIPT).toContain('[ -e "/imports/$1" ]');
  });

  it('list only plain files, never links or folders', () => {
    expect(LIST_SCRIPT).toContain('[ -f "$f" ] && [ ! -L "$f" ]');
  });
});
