/** The part of Docker this needs; dockerode satisfies it. */
export interface ContainerLister {
  listContainers(opts: {
    all: boolean;
    filters: { label: string[] };
  }): Promise<unknown[]>;
}

/**
 * Containers of a Swarm service that are still alive. A service scaled to zero is "stopped" to Swarm at once, but its
 * containers keep running until they have shut down (a database finishes writing first), and they can write to their
 * volume the whole time. Only containers that are really gone make it safe to copy that volume.
 */
export async function liveContainers(docker: ContainerLister, service: string) {
  return (
    await docker.listContainers({
      all: false,
      filters: { label: [`com.docker.swarm.service.name=${service}`] },
    })
  ).length;
}

export async function waitNoContainers(
  docker: ContainerLister,
  service: string,
  label: string,
  { tries = 180, delayMs = 1000 } = {},
) {
  for (let i = 0; i < tries; i++) {
    if ((await liveContainers(docker, service)) === 0) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `${label} still has a container running after ${Math.round((tries * delayMs) / 1000)} seconds, so its data is not safe to copy yet.`,
  );
}
