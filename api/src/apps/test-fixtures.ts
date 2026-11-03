import {
  appDefinition,
  type AppDefinition,
  type AppDefinitionInput,
} from './app.model';

/** An app definition with defaults filled in, for tests. */
export const makeApp = (
  over: Partial<AppDefinitionInput> = {},
): AppDefinition =>
  appDefinition.parse({
    name: 'my-app',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });
