import { describe, expect, it } from 'vitest';
import { explainDeployFailure } from '../src/lib/deploy-failure';

const rolledBack = [
  'Deploying ghcr.io/acme/api:latest (version 1)',
  'Starting: 0/1 instances running…',
  'Docker rolled the update back: the new version did not start.',
];

describe('explainDeployFailure', () => {
  it('explains an image with no build for this CPU, and names the platform', () => {
    const f = explainDeployFailure([
      ...rolledBack,
      'no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found',
    ]);
    expect(f.title).toContain('no build for this server');
    expect(f.title).toContain('linux/arm64/v8');
    expect(f.steps[0]).toContain('linux/arm64 as well');
    expect(f.steps[0]).not.toContain('v8');
  });

  it('recognises a private image with no sign-in, a missing tag and a wrong CPU', () => {
    expect(
      explainDeployFailure(['pull access denied for acme/api']).title,
    ).toMatch(/registry refused/);
    expect(explainDeployFailure(['manifest unknown']).title).toMatch(
      /no image with that tag/,
    );
    expect(explainDeployFailure(['exec format error']).title).toMatch(
      /different CPU/,
    );
  });

  it('explains a crash on start with its exit code, pointing at the logs', () => {
    const f = explainDeployFailure([
      'The containers keep failing to start: task: non-zero exit (137)',
    ]);
    expect(f.title).toContain('exit code 137');
    expect(f.steps[0]).toContain('Logs');
  });

  it('still says something useful for a rollback with no reason, a timeout and the unknown', () => {
    expect(explainDeployFailure(rolledBack).title).toMatch(
      /went back to the old one/,
    );
    expect(explainDeployFailure(['Gave up waiting']).title).toMatch(
      /did not come up in time/,
    );
    expect(explainDeployFailure(['something odd'])).toMatchObject({
      title: 'The deploy did not succeed',
      steps: [],
    });
  });
});
