describe('apiVersion', () => {
  const saved = process.env.PROVELOX_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.PROVELOX_VERSION;
    else process.env.PROVELOX_VERSION = saved;
  });
  const load = () => {
    let v: string | undefined;
    jest.isolateModules(() => {
      v = (require('./version') as { apiVersion?: string }).apiVersion;
    });
    return v;
  };

  it('is the release the image was built from', () => {
    process.env.PROVELOX_VERSION = '0.2.5';
    expect(load()).toBe('0.2.5');
  });
  it('falls back to package.json outside an image', () => {
    delete process.env.PROVELOX_VERSION;
    expect(load()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
