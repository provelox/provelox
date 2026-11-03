import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeStack } from '../test-utils';
import { parseIndex } from './source-index';

// The registry the repository ships (registry/provelox-templates.yaml): every template in it must be readable, declare
// every variable its Compose file uses, and plan and deploy as a project with nothing refused.
const FILE = join(__dirname, '../../../registry/provelox-templates.yaml');
const parsed = parseIndex(readFileSync(FILE, 'utf8'));
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)/g;

describe('the shipped template registry', () => {
  it('has no entry that is skipped', () => {
    expect(parsed.skipped).toEqual([]);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(5);
  });

  it('says what each template is, and keeps its ids unique', () => {
    const ids = parsed.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of parsed.entries) {
      expect(e.description.length).toBeGreaterThan(20);
      expect(e.compose).toBeTruthy();
    }
  });

  for (const e of parsed.entries)
    describe(e.id, () => {
      it('declares every variable its Compose file uses, and uses every one it declares', () => {
        const used = new Set(
          [...(e.compose as string).matchAll(REF)].map((m) => m[1]),
        );
        const declared = new Set(e.variables.map((v) => v.key));
        expect([...used].filter((u) => !declared.has(u))).toEqual([]);
        expect([...declared].filter((d) => !used.has(d))).toEqual([]);
      });

      it('plans and deploys as a project, its main service reachable and its dependencies private', async () => {
        const { projects, docker } = makeStack();
        const variables = Object.fromEntries(
          e.variables.map((v) => [v.key, v.default || 'a-generated-value-123']),
        );
        const input = { compose: e.compose as string, variables };
        const plan = await projects.preview('t', input);
        expect(plan.errors).toEqual([]);
        const services = plan.apps.map((a) => a.serviceAlias);
        expect(services).toContain(e.mainService);
        expect(services.length).toBeGreaterThanOrEqual(2);
        // only the main service is public
        expect(
          plan.apps.filter((a) => a.exposed).map((a) => a.serviceAlias),
        ).toEqual([e.mainService]);
        await projects.deploy('t', input);
        for (const s of services)
          expect(docker.services.has(`pvx-t-${s}`)).toBe(true);
      });
    });
});
