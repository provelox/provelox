import type { MigrationSource } from '../../core/source';
import { caproverApps, readCaproverConfig } from './config';
import { caproverRuntime } from './runtime';

export const caprover: MigrationSource = {
  id: 'caprover',
  title: 'CapRover',
  options: [
    {
      flag: '--captain-dir <dir>',
      description:
        "CapRover's data folder, mounted read-only (default /captain). Its config is read from <dir>/data/config-captain.json.",
    },
    {
      flag: '--root-domain <domain>',
      description: 'Resolves $$cap_root_domain in environment variables.',
    },
  ],
  async read(flags) {
    const dir = (flags['captain-dir'] as string | undefined) ?? '/captain';
    return caproverApps(readCaproverConfig(dir), {
      rootDomain: flags['root-domain'] as string | undefined,
    });
  },
  runtime: caproverRuntime,
};
