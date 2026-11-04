import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planCompose } from '../projects/compose';
import { isValidName } from '../common/naming';
import { summarize, TEMPLATES, templateById } from './catalog';

/** Values a user would end up with: defaults, and a generated string for secrets */
const sampleValues = (t: (typeof TEMPLATES)[number]) =>
  Object.fromEntries(
    t.variables.map((v) => [v.key, v.default ?? 'Gen3rated-secret-value-24']),
  );

const referenced = (compose: string) =>
  [...compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

describe('template catalog', () => {
  it('has unique, valid ids and a description for each', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(isValidName(t.id)).toBe(true);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s', (_id, t) => {
    const plan = planCompose(t.compose, 'sample', sampleValues(t));

    it('deploys cleanly: no errors and no warnings', () => {
      expect(plan.errors).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(plan.apps.length).toBeGreaterThan(0);
    });

    it('declares every variable the compose file uses, and uses every one it declares', () => {
      const declared = t.variables.map((v) => v.key).sort();
      expect([...new Set(referenced(t.compose))].sort()).toEqual(declared);
    });

    it('names a main service that exists', () => {
      expect(plan.apps.map((a) => a.serviceAlias)).toContain(t.mainService);
    });

    it('is public exactly when it says so', () => {
      expect(plan.apps.some((a) => a.exposed)).toBe(t.publicWeb);
    });

    it('says the port it really exposes', () => {
      const exposed = plan.apps.filter((a) => a.exposed);
      if (t.publicWeb)
        expect(exposed.map((a) => a.serviceAlias)).toEqual([t.mainService]);
      // with a connection hint, `port` is the port other apps connect to (RustFS: the S3 API), not the web page's
      if (t.publicWeb && !t.connect)
        expect(exposed[0].containerPort).toBe(t.port);
    });

    it('describes how to connect using only variables it declares', () => {
      const names = new Set(t.variables.map((v) => v.key));
      const used = [
        ...(t.connect ?? '').matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
      ].map((m) => m[1]);
      const allowed = new Set(['host', 'port', ...names]);
      expect(used.filter((n) => !allowed.has(n))).toEqual([]);
    });

    it('keeps data on named volumes, never on the host', () => {
      expect(t.compose).not.toMatch(/- ?\/|- ?\.\//);
      for (const a of plan.apps)
        for (const v of a.volumes) expect(v.volumeName).toBeTruthy();
    });

    it('gives every service app a valid name even for a long project name', () => {
      const long = planCompose(t.compose, 'a'.repeat(20), sampleValues(t));
      expect(long.errors).toEqual([]);
    });

    it('never ships a password in the file itself', () => {
      for (const v of t.variables.filter((x) => x.kind === 'secret'))
        expect(v.default).toBeUndefined();
    });
  });

  it('looks templates up and lists them without their compose files', () => {
    expect(templateById('postgres')?.name).toBe('PostgreSQL');
    expect(templateById('nope')).toBeUndefined();
    expect(JSON.stringify(TEMPLATES.map(summarize))).not.toContain('services:');
  });

  it('only names logos the console actually has', () => {
    const consoleDir = join(__dirname, '../../../console');
    const marks = readFileSync(
      join(consoleDir, 'src/lib/brand-marks.ts'),
      'utf8',
    );
    const missing = TEMPLATES.filter((t) => {
      if (!t.icon) return false;
      return t.icon.startsWith('/brands/')
        ? !existsSync(join(consoleDir, 'public', t.icon))
        : !marks.includes(`\n  ${t.icon}: {`);
    }).map((t) => `${t.id} -> ${t.icon}`);
    expect(missing).toEqual([]);
  });
});
