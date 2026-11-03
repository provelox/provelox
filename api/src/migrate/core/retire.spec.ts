import { planRetire } from './retire';

it('stops what still runs and removes everything it was given, in order', () => {
  const plan = planRetire([
    { name: 'a', replicas: 1 },
    { name: 'b', replicas: 0 },
    { name: 'c', replicas: 2 },
  ]);
  expect(plan.stop).toEqual(['a', 'c']);
  expect(plan.remove).toEqual(['a', 'b', 'c']);
});
