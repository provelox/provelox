import net from 'node:net';
import { ValidationError } from '../common/errors';
import type { DockerPort } from '../docker/docker.port';

export interface JoinOptions {
  token: string;
  /** host:port of a manager of the Swarm to join */
  manager: string;
  /** This machine's address as the others should reach it, when Docker cannot choose */
  advertiseAddr?: string;
}

export type Reach = (host: string, port: number) => Promise<boolean>;

/** Whether a TCP connection opens within a few seconds. */
export const tcpReach: Reach = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 5000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

export function parseManager(value: string): { host: string; port: number } {
  const m = value
    .trim()
    .match(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535)
    throw new ValidationError(
      'Give the manager as host:port, for example 10.0.0.1:2377.',
    );
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

/**
 * Joins this machine to another machine's Swarm. Looks first, so a closed port or a machine that is already in a Swarm
 * is explained before Docker's own, less helpful, error.
 */
export async function joinCluster(
  docker: DockerPort,
  o: JoinOptions,
  reach: Reach = tcpReach,
): Promise<{ manager: string }> {
  if (!/^SWMTKN-1-[A-Za-z0-9-]+$/.test(o.token))
    throw new ValidationError(
      'That does not look like a Swarm join token. Copy it from Settings → Infrastructure on the manager.',
    );
  const target = parseManager(o.manager);
  const state = await docker.swarmState();
  if (state !== 'none')
    throw new ValidationError(
      `This machine is already part of a Swarm (as a ${state}). Leave it first with: docker swarm leave${state === 'manager' ? ' --force' : ''}`,
    );
  if (!(await reach(target.host, target.port)))
    throw new ValidationError(
      `This machine cannot reach ${target.host}:${target.port}. Open 2377/tcp, 7946/tcp and udp, and 4789/udp between the machines, and check the address.`,
    );
  await docker.swarmJoin({
    token: o.token,
    remoteAddr: `${target.host}:${target.port}`,
    advertiseAddr: o.advertiseAddr,
  });
  return { manager: `${target.host}:${target.port}` };
}
