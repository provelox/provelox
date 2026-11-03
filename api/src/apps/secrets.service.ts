import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { LABEL_APP } from '../common/naming';
import { DOCKER, type DockerPort } from '../docker/docker.port';
import { AppsService } from './apps.service';

/** Docker's limit for one secret */
export const MAX_SECRET_BYTES = 500 * 1024;
export const MAX_SECRETS_PER_APP = 50;

/** The name becomes the file under /run/secrets, so it must be a plain file name. */
const secretName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'Secret names use letters, numbers, dots, dashes and underscores.',
  );

export interface SecretInfo {
  name: string;
  createdAt: string;
}

/**
 * Per-app secrets, mounted as files in /run/secrets/<name>. The value goes straight to Docker's secret store and
 * is never kept or returned here: reading a secret back is not possible, only replacing or deleting it.
 */
@Injectable()
export class SecretsService {
  constructor(
    private readonly apps: AppsService,
    @Inject(DOCKER) private readonly docker: DockerPort,
  ) {}

  list(app: string): SecretInfo[] {
    return this.apps
      .getDefinition(app)
      .secrets.map(({ name, createdAt }) => ({ name, createdAt }));
  }

  /** Creates or replaces a secret. The app restarts to pick it up. */
  async set(
    app: string,
    rawName: string,
    value: unknown,
  ): Promise<SecretInfo[]> {
    const name = secretName.safeParse(rawName);
    if (!name.success)
      throw new ValidationError(
        name.error.issues[0]?.message ?? 'Invalid name',
      );
    if (typeof value !== 'string' || value.length === 0)
      throw new ValidationError('A secret needs a value.');
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES)
      throw new ValidationError('A secret can be at most 500 KB.');

    // Secrets cannot change in place: a new value is a new Docker secret that the service switches to
    const dockerName = `pvx-${app}-${name.data}-${randomBytes(5).toString('hex')}`;
    let created: { id: string } | null = null;
    let replaced: { dockerName: string; owner: string } | undefined;
    try {
      await this.apps.mutate(
        app,
        async (current) => {
          const existing = current.secrets.find((s) => s.name === name.data);
          if (!existing && current.secrets.length >= MAX_SECRETS_PER_APP)
            throw new ConflictError(
              `An app can have at most ${MAX_SECRETS_PER_APP} secrets.`,
            );
          created = await this.docker.ensureSecret(dockerName, value, {
            [LABEL_APP]: app,
          });
          replaced = existing && {
            dockerName: existing.dockerName,
            owner: existing.owner ?? app,
          };
          const entry = {
            name: name.data,
            dockerName,
            id: created.id,
            createdAt: new Date().toISOString(),
          };
          return {
            ...current,
            secrets: [
              ...current.secrets.filter((s) => s.name !== name.data),
              entry,
            ],
          };
        },
        { allowMissingSecrets: true },
      );
    } catch (e) {
      // The service did not switch over: the new Docker secret would be an orphan
      if (created)
        await this.docker.removeSecret(dockerName, app).catch(() => undefined);
      throw e;
    }
    // Only now is the old secret unused
    if (replaced)
      await this.docker
        .removeSecret(replaced.dockerName, replaced.owner)
        .catch(() => undefined);
    return this.list(app);
  }

  async remove(app: string, rawName: string): Promise<SecretInfo[]> {
    let removed: { dockerName: string; owner: string } | undefined;
    await this.apps.mutate(
      app,
      async (current) => {
        const existing = current.secrets.find((s) => s.name === rawName);
        if (!existing)
          throw new NotFoundError(
            `The app "${app}" has no secret named "${rawName}".`,
          );
        removed = {
          dockerName: existing.dockerName,
          owner: existing.owner ?? app,
        };
        return {
          ...current,
          secrets: current.secrets.filter((s) => s.name !== rawName),
        };
      },
      { allowMissingSecrets: true },
    );
    if (removed)
      await this.docker
        .removeSecret(removed.dockerName, removed.owner)
        .catch(() => undefined);
    return this.list(app);
  }
}
