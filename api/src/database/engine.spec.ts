import {
  chooseEngine,
  compatible,
  detectFormat,
  dumpFilename,
  nameHint,
} from './engine';

const PG = ['pg_dump', 'pg_dumpall', 'pg_restore', 'psql'];

describe('nameHint', () => {
  it.each([
    ['postgres:16', 'postgres'],
    ['postgres:9.6', 'postgres'],
    ['docker.io/library/postgres', 'postgres'],
    ['postgis/postgis:16-3.4', 'postgres'],
    ['timescale/timescaledb:latest-pg16', 'postgres'],
    ['mariadb:11', 'mariadb'],
    ['mysql:8', 'mysql'],
    ['percona/percona-server:8.0', 'mysql'],
    ['ghcr.io/acme/img-captain-database:3', 'generic'],
    ['acme/app-db:1', 'generic'],
    ['nginx:1.27', null],
    ['ghcr.io/provelox/provelox:0.5.0', null],
    ['redis:7', null],
  ] as const)('%s is %s', (image, hint) => {
    expect(nameHint(image)).toBe(hint);
  });
  it('never reads the tag, and has nothing to say for no image', () => {
    expect(nameHint('nginx:postgres')).toBeNull();
    expect(nameHint(undefined)).toBeNull();
  });
});

describe('chooseEngine', () => {
  it('trusts the tools, not the name alone', () => {
    expect(chooseEngine('postgres', PG)).toEqual({
      engine: 'postgres',
      canBackup: true,
    });
    const c = chooseEngine('postgres', []);
    expect(c.canBackup).toBe(false);
    expect(c).toMatchObject({ engine: 'postgres' });
    expect((c as { reason: string }).reason).toMatch(/pg_dump/);
  });
  it('is nothing for an image that is not named like a database', () => {
    expect(chooseEngine(null, PG)).toMatchObject({
      engine: null,
      canBackup: false,
    });
  });
  it('knows MariaDB 11, which only has the new tool names', () => {
    expect(chooseEngine('mariadb', ['mariadb-dump', 'mariadb'])).toEqual({
      engine: 'mariadb',
      canBackup: true,
    });
    expect(chooseEngine('mysql', ['mysqldump', 'mysql'])).toEqual({
      engine: 'mysql',
      canBackup: true,
    });
  });
  it('settles a name like "img-captain-database" by what the container holds', () => {
    expect(chooseEngine('generic', ['mysqldump', 'mysql'])).toEqual({
      engine: 'mysql',
      canBackup: true,
    });
    expect(chooseEngine('generic', PG)).toEqual({
      engine: 'postgres',
      canBackup: true,
    });
    expect(
      chooseEngine('generic', [...PG, 'mysqldump', 'mysql']),
    ).toMatchObject({ engine: null, canBackup: false });
    expect(chooseEngine('generic', [])).toMatchObject({
      engine: null,
      canBackup: false,
    });
  });
});

describe('detectFormat', () => {
  it('recognises PostgreSQL custom format, gzip and binary files', () => {
    expect(detectFormat(Buffer.from('PGDMP\u0001\u000e\u0000'))).toBe(
      'pg-custom',
    );
    expect(detectFormat(Buffer.from([0x1f, 0x8b, 8, 0]))).toBe('gzip');
    expect(detectFormat(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]))).toBe('binary');
    expect(detectFormat(Buffer.alloc(0))).toBe('binary');
  });
  it('says where SQL came from, and whether it holds more than one database', () => {
    expect(
      detectFormat(Buffer.from('-- MySQL dump 10.13  Distrib 8.0\n--\nCREATE')),
    ).toEqual({ sql: { from: 'mysql', all: false } });
    expect(
      detectFormat(Buffer.from('-- MariaDB dump 10.19  Distrib 11\nSET x')),
    ).toEqual({ sql: { from: 'mariadb', all: false } });
    expect(
      detectFormat(Buffer.from('/*M!999999\\- enable the sandbox mode */\n')),
    ).toEqual({ sql: { from: 'mariadb', all: false } });
    expect(
      detectFormat(Buffer.from('--\n-- PostgreSQL database dump\n--\nSET')),
    ).toEqual({ sql: { from: 'postgres', all: false } });
    expect(
      detectFormat(
        Buffer.from('--\n-- PostgreSQL database cluster dump\n--\nCREATE ROLE'),
      ),
    ).toEqual({ sql: { from: 'postgres', all: true } });
    expect(
      detectFormat(
        Buffer.from('-- MySQL dump 10.13\n--\n-- Current Database: `a`\n--\n'),
      ),
    ).toEqual({ sql: { from: 'mysql', all: true } });
    expect(detectFormat(Buffer.from('CREATE TABLE t (id int);\n'))).toEqual({
      sql: { from: 'unknown', all: false },
    });
  });
});

describe('compatible', () => {
  it('lets MySQL and MariaDB read each other, and nothing else cross over', () => {
    expect(compatible('postgres', 'postgres')).toBe(true);
    expect(compatible('postgres', 'mysql')).toBe(false);
    expect(compatible('mysql', 'mariadb')).toBe(true);
    expect(compatible('mariadb', 'mysql')).toBe(true);
    expect(compatible('mysql', 'postgres')).toBe(false);
    expect(compatible('postgres', 'unknown')).toBe(true);
  });
});

describe('dumpFilename', () => {
  it('names the app, the time in UTC and the kind of file', () => {
    const t = new Date('2026-11-02T04:05:06.789Z');
    expect(dumpFilename('db-track', t, 'custom')).toBe(
      'db-track-20261102-040506.dump',
    );
    expect(dumpFilename('shop', t, 'sql')).toBe('shop-20261102-040506.sql.gz');
    expect(dumpFilename('we/ird name', t, 'sql')).not.toMatch(/[ /]/);
  });
});
