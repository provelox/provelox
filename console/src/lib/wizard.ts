import { explainAppName, isNewAppNameAllowed, parseHost } from './app-name';

export const WIZARD_STEPS = [
  { id: 'basics', label: 'Name' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'review', label: 'Review' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

export interface WizardState {
  name: string;
  groupId: string | null;
  persistent: boolean;
  port: string;
  deployNow: boolean;
  image: string;
  ciKey: boolean;
  /** Serve <name>.<root domain>. Starts as the platform's setting for new apps. */
  defaultSubdomain: boolean;
  /** A domain to attach once the app exists (from typing one as the name), or empty */
  domain: string;
}

export const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,299}$/;

export const initialWizardState = (
  groupId: string | null,
  defaultSubdomain = true,
): WizardState => ({
  name: '',
  groupId,
  persistent: false,
  port: '80',
  deployNow: false,
  image: '',
  ciKey: false,
  defaultSubdomain,
  domain: '',
});

export const parsePort = (v: string) =>
  /^\d{1,5}$/.test(v.trim()) && +v >= 1 && +v <= 65535 ? +v : null;

/** What is wrong with a step's answers, in plain words. Null when the step can be left. */
export function problemWith(
  step: WizardStepId,
  s: WizardState,
  existingApps: string[],
): string | null {
  switch (step) {
    case 'basics':
      if (!s.name) return 'Choose a name for the app.';
      if (existingApps.includes(s.name))
        return 'An app with that name already exists.';
      if (s.domain && parseHost(s.domain) !== s.domain)
        return 'Enter a domain such as api.example.com.';
      return (
        explainAppName(s.name) ??
        (isNewAppNameAllowed(s.name) ? null : 'Invalid name.')
      );
    case 'runtime':
      return parsePort(s.port) === null
        ? 'Enter a port between 1 and 65535.'
        : null;
    case 'deploy':
      if (!s.deployNow) return null;
      if (!s.image.trim())
        return 'Enter the image to deploy, or choose to deploy later.';
      return IMAGE_RE.test(s.image.trim())
        ? null
        : 'Enter a valid image name, e.g. ghcr.io/org/app:tag';
    default:
      return null;
  }
}

/** The first step with a problem, so Create can send you back to it. */
export function firstInvalidStep(
  s: WizardState,
  existingApps: string[],
): WizardStepId | null {
  for (const { id } of WIZARD_STEPS)
    if (problemWith(id, s, existingApps)) return id;
  return null;
}

export type DeployPhase = 'waiting' | 'running' | 'failed' | 'done';

/**
 * Where a deploy is, from what the API reports. "waiting" is the moment before the API has started following it
 * (no log lines yet): polling must not stop then, or a deploy that is about to start would look finished.
 */
export function deployPhase(
  status:
    | { isAppBuilding: boolean; isBuildFailed: boolean; lines: string[] }
    | undefined,
): DeployPhase {
  if (!status || status.lines.length === 0) return 'waiting';
  if (status.isAppBuilding) return 'running';
  return status.isBuildFailed ? 'failed' : 'done';
}
