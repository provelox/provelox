import { ValidationError } from '../common/errors';
import { makeStack } from '../test-utils';
import { DEFAULT_PLACEHOLDER_HTML, withPolicy } from './placeholder.service';

describe('PlaceholderService', () => {
  it('uses the built-in page until one is set', async () => {
    const { placeholder } = makeStack();
    expect(placeholder.html()).toBe(DEFAULT_PLACEHOLDER_HTML);
    expect(placeholder.isCustom()).toBe(false);
  });

  it('names the config after its content so it never changes in place', async () => {
    const { placeholder, docker } = makeStack();
    const a = await placeholder.ensure();
    await placeholder.set('<h1>mine</h1>');
    const b = await placeholder.ensure();
    expect(a.name).not.toBe(b.name);
    expect(docker.configs.get(b.name)).toBe(withPolicy('<h1>mine</h1>'));
    // asking again reuses it
    expect((await placeholder.ensure()).name).toBe(b.name);
  });

  it('restores the default with an empty page and prunes old configs', async () => {
    const { placeholder, docker } = makeStack();
    await placeholder.set('<h1>mine</h1>');
    await placeholder.set('');
    expect(placeholder.isCustom()).toBe(false);
    await placeholder.prune();
    expect(docker.configs.size).toBe(1);
    expect([...docker.configs.values()][0]).toBe(
      withPolicy(DEFAULT_PLACEHOLDER_HTML),
    );
  });

  it('rejects pages over 100 KB', async () => {
    const { placeholder } = makeStack();
    await expect(
      placeholder.set('x'.repeat(101 * 1024)),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
