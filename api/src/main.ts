import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { CONFIG, type Config } from './config/config';

/** Wires the pieces every entry point (server, tests) needs. */
export function configure(app: import('@nestjs/common').INestApplication) {
  // Behind the proxy every request arrives from the proxy's address: trust what it says about the real client, but only
  // when it came from a private address (the proxy's network), so a client cannot name itself
  (
    app as import('@nestjs/common').INestApplication & {
      set(k: string, v: unknown): void;
    }
  ).set('trust proxy', 'loopback, linklocal, uniquelocal');
  // Not announced: the framework's name and version are no help to anyone who reaches the API
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Compose files can be up to 256 KB
  app.use(json({ limit: '1mb' }));
  return app;
}

/** Starts the HTTP server. Run by `node dist/main.js` and by the image's `api` role. */
export async function startServer() {
  const app = configure(
    await NestFactory.create(AppModule, { bodyParser: false }),
  );
  const cfg = app.get<Config>(CONFIG);
  await app.listen(cfg.PORT);
}

if (require.main === module) void startServer();
