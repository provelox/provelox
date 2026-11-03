/**
 * What deleting something takes with it and what it leaves, in plain words, for the confirmation dialogs. It follows
 * what the API really does (apps.service `remove` / `removeManaged`, groups, projects): an app's service, record, deploy
 * keys and Docker secrets go; its data volumes stay for deliberate cleanup. A collection is only a grouping.
 */
export interface Effects {
  goes: string[];
  stays: string[];
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function appDeleteEffects(f: {
  /** Custom domains attached to the app */
  domains: number;
  /** Whether it is served at its default address (<name>.<root domain>) */
  defaultAddress: boolean;
  secrets: number;
  /** Names of its data volumes */
  volumes: string[];
}): Effects {
  const goes = ['The running service, all of its instances'];
  const addresses = f.domains + (f.defaultAddress ? 1 : 0);
  if (addresses > 0)
    goes.push(
      `${plural(addresses, 'address', 'addresses')} it answers on${f.domains ? `, ${plural(f.domains, 'custom domain')} included` : ''}: they stop working`,
    );
  goes.push('Its deploy keys: pipelines that use them can no longer deploy');
  if (f.secrets > 0)
    goes.push(
      `${plural(f.secrets, 'secret')}, deleted from Docker (they cannot be read back)`,
    );
  goes.push('Its settings and environment variables');
  const stays =
    f.volumes.length > 0
      ? [
          `${plural(f.volumes.length, 'data volume')} (${f.volumes.join(', ')}), kept until you clean them up under Settings → Infrastructure`,
        ]
      : ['It has no data volumes, so there is no data to keep.'];
  return { goes, stays };
}

export function groupDeleteEffects(f: { apps: number }): Effects {
  return {
    goes: ['The collection itself, its name and its place in the list'],
    stays:
      f.apps > 0
        ? [
            `${plural(f.apps, 'app')} stay${f.apps === 1 ? 's' : ''} and ${f.apps === 1 ? 'is' : 'are'} no longer in a collection. Nothing is stopped or deleted.`,
          ]
        : ['It has no apps.'],
  };
}

export function projectRemoveEffects(f: {
  services: string[];
  deleteData: boolean;
}): Effects {
  const goes = [
    f.services.length > 0
      ? `${plural(f.services.length, 'service')} (${f.services.join(', ')}) and their instances`
      : 'Its services and their instances',
    'The private network the services share',
    'Its deploy keys and secrets',
  ];
  if (f.deleteData)
    goes.push('Its data volumes: databases and uploads, erased for good');
  return {
    goes,
    stays: f.deleteData
      ? ['Nothing is kept: you chose to delete the data too.']
      : ['Its data volumes, kept until you clean them up (or tick the box).'],
  };
}
