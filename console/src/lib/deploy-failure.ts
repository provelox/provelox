export interface DeployFailure {
  /** What went wrong, in a sentence */
  title: string;
  /** Why, in plain words */
  why: string;
  /** What to do about it, one step each */
  steps: string[];
}

interface Rule {
  test: RegExp;
  explain: (match: RegExpMatchArray) => DeployFailure;
}

const RULES: Rule[] = [
  {
    // Docker: no matching manifest for linux/arm64/v8 in the manifest list entries
    test: /no matching manifest for (linux\/[\w/]+)/i,
    explain: (m) => ({
      title: `This image has no build for this server's CPU (${m[1]})`,
      why: 'The image was published for a different processor than the one this server has (for example amd64 only, on an arm64 server), so Docker refused to start it.',
      steps: [
        `Publish the image for ${m[1].replace(/\/v\d+$/, '')} as well, for example with docker buildx build --platform linux/amd64,linux/arm64.`,
        'Then deploy again. The app and its settings are kept.',
      ],
    }),
  },
  {
    test: /pull access denied|unauthorized|authentication required|denied: /i,
    explain: () => ({
      title: 'The registry refused to give out the image',
      why: 'Either the image name is wrong, or it is private and this server has no sign-in for its registry.',
      steps: [
        'Check the image name and tag for typos.',
        'For a private image, add the registry under Settings, Registries, then deploy again.',
      ],
    }),
  },
  {
    test: /manifest unknown|not found: manifest|manifest for .* not found/i,
    explain: () => ({
      title: 'There is no image with that tag',
      why: 'The registry knows the image name, but not the tag you asked for.',
      steps: [
        'Check the tag. If your CI builds it, make sure that build finished and pushed.',
      ],
    }),
  },
  {
    test: /exec format error/i,
    explain: () => ({
      title: 'The image was built for a different CPU',
      why: 'The program inside could not run on this server’s processor.',
      steps: [
        'Build and publish the image for this server’s platform (usually linux/amd64 or linux/arm64), then deploy again.',
      ],
    }),
  },
  {
    test: /non-zero exit \((\d+)\)|exited with code (\d+)/i,
    explain: (m) => ({
      title: `The app started and stopped straight away (exit code ${m[1] ?? m[2]})`,
      why: 'Docker keeps restarting it and it keeps stopping, so it was rolled back.',
      steps: [
        'Open the Logs tab for the app’s own output: the reason is usually printed there.',
        'Check the settings it needs at start, such as environment variables and the port it listens on.',
      ],
    }),
  },
  {
    test: /no such image|image .* could not be accessed|failed to resolve reference/i,
    explain: () => ({
      title: 'The image could not be found',
      why: 'Docker could not look the image up.',
      steps: ['Check the image name, tag and registry, then deploy again.'],
    }),
  },
];

/**
 * Turns the lines of a failed deploy into something a person can act on. Unknown failures still get a headline that
 * says what happened, with the raw lines left as the detail.
 */
export function explainDeployFailure(lines: string[]): DeployFailure {
  const text = lines.join('\n');
  for (const rule of RULES) {
    const m = text.match(rule.test);
    if (m) return rule.explain(m);
  }
  if (/rolled the update back/i.test(text))
    return {
      title:
        'The new version did not start, so Docker went back to the old one',
      why: 'Docker gave no reason this time.',
      steps: [
        'Open the Logs tab, or check the details below, then deploy again.',
      ],
    };
  if (/did not become healthy|timed out|gave up/i.test(text))
    return {
      title: 'The app did not come up in time',
      why: 'It was still starting when Provelox stopped waiting.',
      steps: ['Open the Logs tab to see how far it got.'],
    };
  return {
    title: 'The deploy did not succeed',
    why: 'The details below say what Docker reported.',
    steps: [],
  };
}
