import { waitNoContainers } from './live-containers';

const lister = (counts: number[]) => {
  const asked: unknown[] = [];
  return {
    asked,
    listContainers: async (o: unknown) => {
      asked.push(o);
      return new Array(counts.length > 1 ? counts.shift() : counts[0]).fill({});
    },
  };
};

describe('waitNoContainers', () => {
  it('keeps waiting while a container is still shutting down', async () => {
    const d = lister([2, 1, 0]);
    await waitNoContainers(d, 'srv-captain--db', 'db', { delayMs: 0 });
    expect(d.asked).toHaveLength(3);
    expect(d.asked[0]).toEqual({
      all: false,
      filters: { label: ['com.docker.swarm.service.name=srv-captain--db'] },
    });
  });
  it('refuses to go on if a container never exits', async () => {
    await expect(
      waitNoContainers(lister([1]), 'x', 'db', { tries: 3, delayMs: 0 }),
    ).rejects.toThrow(/db still has a container running/);
  });
});
