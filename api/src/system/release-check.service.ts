import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';
import { ValidationError } from '../common/errors';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { SELF_SERVICE } from '../self/api-spec';
import { compareVersions, VERSION } from '../self/self-update';
import { SettingsService } from './settings.service';

/** How long an answer is trusted, how soon to try again after a failure, and how often "check now" is honoured */
export const FRESH_MS = 6 * 3600_000;
export const RETRY_MS = 30 * 60_000;
export const FORCE_EVERY_MS = 60_000;
/** A first look waits this long for the release server, so the first page already knows; later looks never wait */
const FIRST_LOOK_MS = 1500;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_000_000;
/** How many releases' notes are kept, and how much of each: the notes are shown in the console, not stored for ever */
const MAX_NOTES = 10;
const NOTE_MAX_CHARS = 20_000;

/** The image's old name, before the project moved to its own organization: it is no longer published */
const OLD_IMAGE_REPO = 'ghcr.io/floms/provelox';

/** How `fetch` is reached, so tests can answer for the release server */
export const RELEASE_FETCH = Symbol('RELEASE_FETCH');
export type ReleaseFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type Step = 'major' | 'minor' | 'patch';

/** What one release says about itself (its notes, as the project wrote them in Markdown) */
export interface ReleaseNote {
  version: string;
  publishedAt: string | null;
  url: string | null;
  body: string;
}

export interface ReleaseStatus {
  /** Checking is on: the environment allows it and the admin has not turned it off */
  enabled: boolean;
  /** The environment (UPDATE_CHECK=false) turned it off, so Settings cannot turn it on */
  lockedOff: boolean;
  /** The release this server runs, or null for a build that is not a release (a developer's) */
  current: string | null;
  /** The newest stable release the last successful look found */
  latest: string | null;
  updateAvailable: boolean;
  /** How big the step from current to latest is */
  step: Step | null;
  /** Before 1.0 a minor step can change the stored data, and a major step may: copy the data volume first */
  careful: boolean;
  notesUrl: string | null;
  /** The notes of every stable release newer than the one running, up to the latest, newest first (empty when current) */
  notes: ReleaseNote[];
  /** How many notes there are, also when `notes` was left out of the answer (`?notes=0`) */
  noteCount: number;
  publishedAt: string | null;
  checkedAt: string | null;
  checking: boolean;
  /** Why the last look failed (and the answer above is older), in plain words */
  error: string | null;
  /** This server runs the image under its old name, which gets no more releases: it has to be moved by hand once */
  imageMoved: boolean;
  /** The API runs as a Swarm service, so it can update itself from here */
  canUpdate: boolean;
}

interface Known {
  latest: string;
  notesUrl: string | null;
  publishedAt: string | null;
  notes: ReleaseNote[];
}
interface Attempt {
  at: number;
  error: string | null;
}

const core = (v: string) => v.split(/-(.+)/)[0].split('.').map(Number);

/** How far apart two releases are: a release candidate and its own release are a patch apart */
export function stepOf(from: string, to: string): Step {
  const a = core(from);
  const b = core(to);
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  return 'patch';
}

/** Before 1.0 the stored data and the settings may change between minor versions (see the install guide) */
export const isCareful = (from: string, to: string) => {
  const step = stepOf(from, to);
  return step === 'major' || (step === 'minor' && core(from)[0] === 0);
};

/** The running release, if this is a release at all: a build without PROVELOX_VERSION is a developer's and never updates */
function runningRelease(): string | null {
  const v = process.env.PROVELOX_VERSION?.trim().replace(/^v/, '');
  return v && VERSION.test(v) ? v : null;
}

/**
 * Knows whether the project has published a newer release than the one running, from one fixed address (GitHub's
 * "latest release", which is never a candidate or a draft). It only looks and reports: nothing is ever installed
 * without an admin asking for it (see SelfUpdateService). What it sends is an ordinary request: this server's address
 * and the user agent "provelox/<release>". It can be turned off by the environment or in Settings.
 */
@Injectable()
export class ReleaseCheckService {
  private known: Known | null = null;
  private attempt: Attempt | null = null;
  private running: Promise<void> | null = null;
  private lastForce = 0;

  constructor(
    @Inject(DOCKER) private readonly docker: DockerPort,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly settings: SettingsService,
    @Inject(RELEASE_FETCH) private readonly http: ReleaseFetch,
  ) {}

  enabled(): boolean {
    return this.cfg.UPDATE_CHECK && this.settings.updateCheck();
  }

  /** Turns checking on or off for this server. The environment can forbid "on". */
  setEnabled(on: boolean): { enabled: boolean } {
    if (on && !this.cfg.UPDATE_CHECK)
      throw new ValidationError(
        "Checking is turned off by UPDATE_CHECK=false in this server's environment. Remove that setting first.",
      );
    this.settings.set('updateCheck', on);
    if (!on) {
      this.known = null;
      this.attempt = null;
    }
    return { enabled: this.enabled() };
  }

  private stale(now: number) {
    return (
      !this.attempt ||
      now - this.attempt.at > (this.attempt.error ? RETRY_MS : FRESH_MS)
    );
  }

  /** The answer from memory, at once; anything missing or old is looked up behind this call (the first look waits briefly) */
  async report(now = Date.now()): Promise<ReleaseStatus> {
    if (this.enabled() && this.stale(now)) {
      const look = this.refresh(now);
      if (!this.attempt)
        await Promise.race([
          look,
          new Promise((r) => setTimeout(r, FIRST_LOOK_MS).unref()),
        ]);
    }
    return this.status();
  }

  /** Asks again now, whatever is remembered; at most once a minute (a second call inside it only reports) */
  async force(now = Date.now()): Promise<ReleaseStatus> {
    if (this.enabled() && now - this.lastForce >= FORCE_EVERY_MS) {
      this.lastForce = now;
      await Promise.race([
        this.refresh(now),
        new Promise((r) => setTimeout(r, TIMEOUT_MS + 500).unref()),
      ]);
    }
    return this.status();
  }

  private refresh(now: number): Promise<void> {
    if (this.running) return this.running;
    this.running = this.look()
      .then((k) => {
        this.known = k;
        this.attempt = { at: now, error: null };
      })
      .catch((e: unknown) => {
        this.attempt = {
          at: now,
          error: e instanceof Error ? e.message : 'Could not check.',
        };
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** One request; the answer is read with a size limit and must be JSON, or this says why in plain words */
  private async get(url: string, current: string | null): Promise<unknown> {
    let res: Response;
    try {
      res = await this.http(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `provelox/${current ?? 'dev'}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        'Could not reach the server that publishes releases. Is this server allowed to reach the internet?',
      );
    }
    if (!res.ok)
      throw new Error(
        `The server that publishes releases answered ${res.status}${res.status === 403 || res.status === 429 ? ' (too many requests from this address; try again later)' : ''}.`,
      );
    const text = await res.text();
    if (text.length > MAX_BYTES)
      throw new Error('The answer about releases was far too large.');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('The answer about releases was not understood.');
    }
  }

  /** The newest stable release; everything in the answer is checked before it is believed */
  private async look(): Promise<Known> {
    const current = runningRelease();
    const note = readNote(await this.get(this.cfg.RELEASES_URL, current));
    if (!note) throw new Error('The answer about releases was not understood.');
    const known: Known = {
      latest: note.version,
      notesUrl: note.url,
      publishedAt: note.publishedAt,
      notes: [note],
    };
    // Only when there is something to update to: what the releases in between say, so none is skipped unread. A
    // failure here costs the extra notes, never the answer that an update exists.
    if (current && compareVersions(note.version, current) > 0)
      known.notes = await this.notesBetween(current, note).catch(() => [note]);
    return known;
  }

  /** The stable releases after `current` up to `latest`, newest first; the latest's own notes if the list is no help */
  private async notesBetween(
    current: string,
    latest: ReleaseNote,
  ): Promise<ReleaseNote[]> {
    // GitHub's list lives next to its "latest": .../releases/latest -> .../releases?per_page=20
    const url = this.cfg.RELEASES_URL.replace(
      /\/latest\/?$/,
      `?per_page=${MAX_NOTES * 2}`,
    );
    if (url === this.cfg.RELEASES_URL) return [latest];
    const list = await this.get(url, current);
    if (!Array.isArray(list)) return [latest];
    const found = list
      .map(readNote)
      .filter(
        (n): n is ReleaseNote =>
          !!n &&
          compareVersions(n.version, current) > 0 &&
          compareVersions(n.version, latest.version) <= 0,
      )
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, MAX_NOTES);
    // the latest is always there, with the text it had when it was found, even if the list was cut short
    return found.some((n) => n.version === latest.version)
      ? found
      : [latest, ...found].slice(0, MAX_NOTES);
  }

  private async status(): Promise<ReleaseStatus> {
    const current = runningRelease();
    const enabled = this.enabled();
    const latest = enabled ? (this.known?.latest ?? null) : null;
    const updateAvailable =
      !!current && !!latest && compareVersions(latest, current) > 0;
    let imageMoved = false;
    let canUpdate = false;
    if (updateAvailable) {
      // Only asked when there is something to update to: it costs a look at the running service
      const api = await this.docker
        .serviceStatus(SELF_SERVICE)
        .catch(() => null);
      canUpdate = !!api?.image;
      imageMoved = !!api?.image && repoOf(api.image) === OLD_IMAGE_REPO;
    }
    return {
      enabled,
      lockedOff: !this.cfg.UPDATE_CHECK,
      current,
      latest,
      updateAvailable,
      step: updateAvailable ? stepOf(current!, latest!) : null,
      careful: updateAvailable ? isCareful(current!, latest!) : false,
      notesUrl: updateAvailable ? (this.known?.notesUrl ?? null) : null,
      notes: updateAvailable && enabled ? (this.known?.notes ?? []) : [],
      noteCount:
        updateAvailable && enabled ? (this.known?.notes.length ?? 0) : 0,
      publishedAt: enabled ? (this.known?.publishedAt ?? null) : null,
      checkedAt:
        enabled && this.attempt && !this.attempt.error
          ? new Date(this.attempt.at).toISOString()
          : null,
      checking: this.running !== null,
      error: enabled ? (this.attempt?.error ?? null) : null,
      imageMoved,
      canUpdate,
    };
  }
}

/** "ghcr.io/org/name:1.2.3@sha256:..." -> "ghcr.io/org/name" */
function repoOf(image: string): string {
  const noDigest = image.split('@')[0];
  const colon = noDigest.lastIndexOf(':');
  return colon > noDigest.lastIndexOf('/')
    ? noDigest.slice(0, colon)
    : noDigest;
}

/** A link from the answer is only used when it is an https address on github.com */
function githubUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'github.com'
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * One release from GitHub's JSON, or null when it is not a stable, published release with a version we understand.
 * The text is kept as written (Markdown) but cut at a sensible length; the console renders it without raw HTML.
 */
function readNote(v: unknown): ReleaseNote | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const version =
    typeof r.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
  if (!VERSION.test(version) || r.draft === true || r.prerelease === true)
    return null;
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  return {
    version,
    publishedAt:
      typeof r.published_at === 'string' &&
      !Number.isNaN(Date.parse(r.published_at))
        ? new Date(r.published_at).toISOString()
        : null,
    url: githubUrl(r.html_url),
    body:
      body.length > NOTE_MAX_CHARS
        ? `${body.slice(0, NOTE_MAX_CHARS).trimEnd()}…`
        : body,
  };
}
