import { Logger } from '@nestjs/common';
import { ConflictError, UnauthorizedError } from './errors';
import { AllExceptionsFilter } from './http-exception.filter';

function host(method = 'PATCH', path = '/v1/apps/x') {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return {
    res,
    h: {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method, path }),
      }),
    } as never,
  };
}

describe('AllExceptionsFilter logging', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('records what was asked and why it was refused, never the body', () => {
    const { h, res } = host();
    new AllExceptionsFilter().catch(new ConflictError('already there'), h);
    expect(warn).toHaveBeenCalledWith('PATCH /v1/apps/x -> 409 already there');
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('stays quiet about signed-out and not-found calls, which are everyday noise', () => {
    const { h } = host();
    new AllExceptionsFilter().catch(new UnauthorizedError('Invalid token'), h);
    expect(warn).not.toHaveBeenCalled();
  });
});
