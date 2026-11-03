import { describe, expect, it } from 'vitest';
import { extractVariables } from '@/lib/compose-vars';
import { REGISTRY_EXAMPLES } from '@/lib/registry-examples';

type Entry = {
  id: string;
  compose?: string;
  composeFile?: string;
  variables?: { key: string }[];
};

describe('the registry examples shown in the help', () => {
  for (const ex of REGISTRY_EXAMPLES)
    it(`${ex.label}: is valid JSON, and every ${'${VAR}'} the Compose file uses is declared`, () => {
      const index = JSON.parse(
        ex.files.find((f) => f.name.endsWith('.json'))!.content,
      ) as { templates: Entry[] };
      expect(index.templates.length).toBeGreaterThan(0);
      for (const t of index.templates) {
        const compose =
          t.compose ??
          ex.files.find((f) => f.name === t.composeFile)?.content ??
          '';
        expect(compose, `${t.id} has a Compose file`).not.toBe('');
        const declared = new Set((t.variables ?? []).map((v) => v.key));
        for (const v of extractVariables(compose))
          expect(declared.has(v.key), `${v.key} is declared`).toBe(true);
      }
    });
});
