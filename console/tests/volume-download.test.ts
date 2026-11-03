import { describe, expect, it } from 'vitest';
import {
  looksLikeDatabase,
  VOLUME_NAME_RE,
  volumeDownloadUrl,
} from '@/lib/volume-download';

describe('looksLikeDatabase', () => {
  it.each([
    'postgres:16',
    'postgis/postgis:16-3.4',
    'pgvector/pgvector:pg16',
    'postgres:9.6',
    'docker.io/library/mysql:8',
    'mariadb',
    'mongo:7',
    'redis:7-alpine',
    'valkey/valkey:8',
    'bitnami/postgresql:16',
    'timescale/timescaledb:latest-pg16',
    'clickhouse/clickhouse-server',
    'ghcr.io/acme/img-captain-database:3',
    'ghcr.io/acme/app-db:1',
  ])('knows %s is a database', (image) =>
    expect(looksLikeDatabase(image)).toBe(true),
  );

  it.each([
    'nginx:1.27',
    'ghcr.io/acme/website:20251224-080901',
    'ghcr.io/provelox/provelox:0.5.0-rc.15',
    'traefik:v3.6',
    'node:24-slim',
    'dbeaver/cloudbeaver',
    undefined,
    '',
  ])('does not take %s for one', (image) =>
    expect(looksLikeDatabase(image)).toBe(false),
  );

  it('judges the name, not the tag', () => {
    expect(looksLikeDatabase('ghcr.io/acme/blog:postgres')).toBe(false);
    expect(looksLikeDatabase('postgres@sha256:abc')).toBe(true);
  });
});

describe('volumeDownloadUrl', () => {
  it('is the console route, with the app and volume made safe for an address', () => {
    expect(volumeDownloadUrl('files', 'data', false)).toBe(
      '/api/volumes/files/data/download',
    );
    expect(volumeDownloadUrl('files', 'a b/c', true)).toBe(
      '/api/volumes/files/a%20b%2Fc/download?stop=1',
    );
  });
});

describe('VOLUME_NAME_RE', () => {
  it('accepts the names a volume has and nothing that can walk elsewhere', () => {
    for (const ok of ['data', 'pg_data', 'db-1', 'a.b'])
      expect(ok).toMatch(VOLUME_NAME_RE);
    for (const bad of ['', '../x', 'a/b', '-x', '.hidden', 'a b'])
      expect(bad).not.toMatch(VOLUME_NAME_RE);
  });
});
