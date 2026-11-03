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
});
