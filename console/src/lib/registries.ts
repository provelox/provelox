/** Docker registry credentials. Pure helpers, kept free of server-only imports so they can be tested. */

/** What the browser is allowed to see: everything except the password (which the API never returns). */
export interface PublicRegistry {
  id: string;
  registryUser: string;
  registryDomain: string;
  createdAt: string;
}

export function toPublicRegistry(r: {
  id: string;
  domain: string;
  username: string;
  createdAt: string;
}): PublicRegistry {
  return {
    id: r.id,
    registryUser: r.username,
    registryDomain: r.domain,
    createdAt: r.createdAt,
  };
}

/** "https://GHCR.io/" → "ghcr.io". Keeps an explicit port ("registry.example.com:5000"). */
export function normalizeRegistryDomain(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

const DOMAIN_RE =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export function registryDomainProblem(domain: string): string | null {
  if (!domain) return 'Enter the registry domain, for example ghcr.io';
  if (!DOMAIN_RE.test(domain))
    return 'Enter just the domain (and port if needed), without https:// or a path';
  return null;
}

/** An existing registry for the same host: a second one would never be used. */
export function findDuplicate(
  registries: PublicRegistry[],
  domain: string,
  exceptId?: string,
): PublicRegistry | undefined {
  return registries.find(
    (r) =>
      r.id !== exceptId &&
      r.registryDomain.toLowerCase() === domain.toLowerCase(),
  );
}

/** The registry host an image reference points at ("nginx" and "acme/app" are Docker Hub). Mirrors the API. */
export function registryOf(image: string): string {
  const first = image.split('/')[0];
  const hasHost =
    image.includes('/') &&
    (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!hasHost) return 'docker.io';
  return first === 'index.docker.io' || first === 'registry-1.docker.io'
    ? 'docker.io'
    : first.toLowerCase();
}

/** Which of these registries the API would use to pull `image`. */
export function registryForImage(
  registries: PublicRegistry[],
  image: string,
): PublicRegistry | undefined {
  const host = registryOf(image);
  return registries.find(
    (r) => normalizeRegistryDomain(r.registryDomain) === host,
  );
}

/** What a provider's logo is: a brand mark, or (where no mark is available) a short word on the brand's colour. */
export type RegistryMark =
  { kind: 'brand'; slug: string } | { kind: 'text'; text: string; bg: string };

export interface RegistryPreset {
  id: string;
  label: string;
  /** The registry's address when it is always the same; empty when it depends on the account */
  domain: string;
  /** For providers whose address is yours (my-acct.azurecr.io): what to type, and what it must look like */
  domainPlaceholder?: string;
  domainPattern?: RegExp;
  domainProblem?: string;
  userHint: string;
  /** A username the provider always wants ("AWS", "_json_key") */
  fixedUser?: string;
  secretLabel: string;
  secretHint: string;
  /** The secret is a file's contents (Google's key file), not a one-line token */
  secretIsFile?: boolean;
  /** What a good secret begins with; anything else only gets a nudge, since providers do change their formats */
  secretPrefix?: RegExp;
  secretNudge?: string;
  /** Something to know before adding it */
  note?: string;
  /** Where to make the token */
  help?: { label: string; url: string };
  mark: RegistryMark;
}

export const REGISTRY_PRESETS: RegistryPreset[] = [
  {
    id: 'dockerhub',
    label: 'Docker Hub',
    domain: 'docker.io',
    userHint: 'Your Docker Hub username',
    secretLabel: 'Access token',
    secretHint:
      'A Docker Hub access token (Account settings, Security). Better than your password.',
    secretPrefix: /^dckr_pat_/,
    secretNudge:
      'Docker Hub access tokens start with dckr_pat_. A password works but is riskier to store.',
    help: {
      label: 'Create an access token',
      url: 'https://app.docker.com/settings/personal-access-tokens',
    },
    mark: { kind: 'brand', slug: 'docker' },
  },
  {
    id: 'ghcr',
    label: 'GitHub',
    domain: 'ghcr.io',
    userHint: 'Your GitHub username',
    secretLabel: 'Personal access token',
    secretHint:
      'A personal access token (classic) with the read:packages scope.',
    secretPrefix: /^(ghp_|github_pat_|gho_|ghs_)/,
    secretNudge:
      'GitHub needs a personal access token (it starts with ghp_ or github_pat_), not your password.',
    help: {
      label: 'Create a token',
      url: 'https://github.com/settings/tokens/new?scopes=read:packages',
    },
    mark: { kind: 'brand', slug: 'github' },
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    domain: 'registry.gitlab.com',
    userHint: 'Your GitLab username, or a deploy token’s username',
    secretLabel: 'Token',
    secretHint: 'A personal or deploy token with the read_registry scope.',
    secretPrefix: /^(glpat-|gldt-|[A-Za-z0-9_-]{20,})/,
    secretNudge: 'GitLab needs a token with read_registry, not your password.',
    help: {
      label: 'Create a token',
      url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    },
    mark: { kind: 'brand', slug: 'gitlab' },
  },
  {
    id: 'google',
    label: 'Google Cloud',
    domain: '',
    domainPlaceholder: 'europe-west1-docker.pkg.dev',
    domainPattern: /^([a-z0-9-]+-docker\.pkg\.dev|([a-z]+\.)?gcr\.io)$/,
    domainProblem:
      'Use the registry address: REGION-docker.pkg.dev (Artifact Registry) or gcr.io.',
    userHint: 'Always _json_key for a service account key',
    fixedUser: '_json_key',
    secretLabel: 'Service account key (JSON)',
    secretHint:
      'The whole JSON key file of a service account that can read the repository (Artifact Registry Reader).',
    secretIsFile: true,
    help: {
      label: 'Service account keys',
      url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    },
    mark: { kind: 'brand', slug: 'googlecloud' },
  },
  {
    id: 'ecr',
    label: 'Amazon ECR',
    domain: '',
    domainPlaceholder: '123456789012.dkr.ecr.eu-west-1.amazonaws.com',
    domainPattern:
      /^\d{12}\.dkr\.ecr(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
    domainProblem:
      'Use the full address: ACCOUNT-ID.dkr.ecr.REGION.amazonaws.com.',
    userHint: 'Always AWS',
    fixedUser: 'AWS',
    secretLabel: 'Login password',
    secretHint:
      'The output of: aws ecr get-login-password --region YOUR-REGION',
    note: 'ECR passwords expire after 12 hours. Pulls will start failing after that until you save a fresh one, so this suits trying things out more than a running setup.',
    mark: { kind: 'text', text: 'ECR', bg: '#FF9900' },
  },
  {
    id: 'azure',
    label: 'Azure Container Registry',
    domain: '',
    domainPlaceholder: 'myregistry.azurecr.io',
    domainPattern: /^[a-z0-9]{5,50}\.azurecr\.(io|cn|us)$/,
    domainProblem: 'Use the registry address: NAME.azurecr.io.',
    userHint: 'The registry’s admin username or a service principal’s ID',
    secretLabel: 'Password or secret',
    secretHint:
      'The admin password, a repository token, or a service principal secret.',
    help: {
      label: 'Azure portal',
      url: 'https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.ContainerRegistry%2Fregistries',
    },
    mark: { kind: 'text', text: 'ACR', bg: '#0078D4' },
  },
  {
    id: 'quay',
    label: 'Quay',
    domain: 'quay.io',
    userHint: 'Your Quay username, or a robot account (acme+robot)',
    secretLabel: 'Password or robot token',
    secretHint: 'A robot account token with read access is best.',
    mark: { kind: 'text', text: 'Quay', bg: '#40B4E5' },
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    domain: 'registry.digitalocean.com',
    userHint: 'Your API token (as the username too), or an email',
    secretLabel: 'API token',
    secretHint: 'A DigitalOcean API token with read access to the registry.',
    help: {
      label: 'API tokens',
      url: 'https://cloud.digitalocean.com/account/api/tokens',
    },
    mark: { kind: 'brand', slug: 'digitalocean' },
  },
  {
    id: 'custom',
    label: 'Other registry',
    domain: '',
    domainPlaceholder: 'registry.example.com:5000',
    userHint: 'The registry username',
    secretLabel: 'Password or access token',
    secretHint: 'The registry password or access token.',
    note: 'For Harbor, Nexus, a self-hosted registry or any other. Use https:// addresses only; a registry without HTTPS needs Docker configured to allow it.',
    mark: { kind: 'brand', slug: 'harbor' },
  },
];

/** Which provider an address belongs to, for the logo and the label. "custom" when it is none of them. */
export function providerOf(domain: string): RegistryPreset {
  const d = normalizeRegistryDomain(domain);
  const found = REGISTRY_PRESETS.find(
    (p) =>
      p.id !== 'custom' &&
      (p.domain ? p.domain === d : !!p.domainPattern?.test(d)),
  );
  return found ?? (REGISTRY_PRESETS.at(-1) as RegistryPreset);
}

export interface RegistryCheck {
  domain?: string;
  user?: string;
  secret?: string;
  /** Not a reason to refuse: a nudge */
  warning?: string;
  /** Nothing is wrong and nothing is missing */
  ok: boolean;
}

/**
 * What is wrong with what was typed, before it is sent anywhere. The provider says what its addresses and logins look
 * like; the registry itself has the last word when the login is checked.
 */
export function checkRegistryInput(
  preset: RegistryPreset,
  input: { domain: string; user: string; secret: string },
  opts: { editing: boolean; existing?: PublicRegistry[]; exceptId?: string },
): RegistryCheck {
  const out: RegistryCheck = { ok: false };
  const domain = normalizeRegistryDomain(input.domain);
  if (!opts.editing) {
    out.domain =
      (domain ? registryDomainProblem(domain) : null) ??
      (domain && preset.domainPattern && !preset.domainPattern.test(domain)
        ? preset.domainProblem
        : undefined) ??
      undefined;
    if (!out.domain && domain && opts.existing) {
      const dup = findDuplicate(opts.existing, domain, opts.exceptId);
      if (dup)
        out.domain = `${dup.registryDomain} is already added. Edit that one instead.`;
    }
  }
  const user = input.user.trim();
  if (user && /\s/.test(user)) out.user = 'A username has no spaces.';
  const secret = preset.secretIsFile ? input.secret.trim() : input.secret;
  if (secret) {
    if (preset.secretIsFile) {
      try {
        const k = JSON.parse(secret) as Record<string, unknown>;
        if (
          typeof k.client_email !== 'string' ||
          typeof k.private_key !== 'string'
        )
          out.secret =
            'That JSON is not a service account key: it needs client_email and private_key.';
      } catch {
        out.secret = 'Paste the whole JSON key file.';
      }
    } else if (/\s/.test(secret.trim()))
      out.secret = 'A token has no spaces or line breaks. Copy it again.';
    else if (preset.secretPrefix && !preset.secretPrefix.test(secret.trim()))
      out.warning = preset.secretNudge;
  }
  out.ok =
    !!domain &&
    !out.domain &&
    !!(preset.fixedUser ?? user) &&
    !out.user &&
    (opts.editing ? !out.secret : !!secret && !out.secret);
  return out;
}
