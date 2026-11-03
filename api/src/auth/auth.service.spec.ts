import {
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { AuthService } from './auth.service';
import { makeStack } from '../test-utils';

function auth(
  env: Record<string, string> = { ADMIN_PASSWORD: 'correct horse' },
) {
  const s = makeStack(env);
  const a = new AuthService(s.settings, s.cfg);
  a.onModuleInit();
  return a;
}

describe('AuthService', () => {
  it('signs in with the configured password and verifies the token', () => {
    const a = auth();
    const { token } = a.login('correct horse');
    expect(() => a.verify(token)).not.toThrow();
  });

  it('rejects a wrong password with a generic error', () => {
    const a = auth();
    expect(() => a.login('nope')).toThrow(
      new UnauthorizedError('Invalid credentials'),
    );
    expect(() => a.login('')).toThrow(UnauthorizedError);
  });

  it('has no default password: one is generated when none is configured', () => {
    const a = auth({});
    expect(() => a.login('captain42')).toThrow(UnauthorizedError);
    expect(() => a.login('provelox')).toThrow(UnauthorizedError);
  });

  it('keeps the password across restarts', () => {
    const s = makeStack({ ADMIN_PASSWORD: 'first-password' });
    const a1 = new AuthService(s.settings, s.cfg);
    a1.onModuleInit();
    const a2 = new AuthService(s.settings, {
      ...s.cfg,
      ADMIN_PASSWORD: 'different',
    });
    a2.onModuleInit();
    expect(() => a2.login('first-password')).not.toThrow();
  });

  it('slows down guessing', () => {
    const a = auth();
    for (let i = 0; i < 5; i++)
      expect(() => a.login('bad', 1000 + i)).toThrow(UnauthorizedError);
    expect(() => a.login('correct horse', 1100)).toThrow(TooManyRequestsError);
    // after the window the right password works again
    expect(() => a.login('correct horse', 1000 + 31_000)).not.toThrow();
  });

  it('counts wrong passwords per client, so one cannot lock out another', () => {
    const a = auth();
    for (let i = 0; i < 5; i++)
      expect(() => a.login('bad', 1000 + i, '1.1.1.1')).toThrow(
        UnauthorizedError,
      );
    expect(() => a.login('correct horse', 1100, '1.1.1.1')).toThrow(
      TooManyRequestsError,
    );
    expect(() => a.login('correct horse', 1100, '2.2.2.2')).not.toThrow();
  });

  it('still caps a guesser who keeps changing address', () => {
    const a = auth();
    for (let i = 0; i < 40; i++)
      expect(() => a.login('bad', 1000 + i, `10.0.0.${i}`)).toThrow(
        UnauthorizedError,
      );
    expect(() => a.login('correct horse', 1100, '9.9.9.9')).toThrow(
      TooManyRequestsError,
    );
  });

  it('rejects garbage and tampered tokens', () => {
    const a = auth();
    expect(() => a.verify('garbage')).toThrow(UnauthorizedError);
    const { token } = a.login('correct horse');
    expect(() => a.verify(`${token}x`)).toThrow(UnauthorizedError);
  });

  describe('changePassword', () => {
    it('changes it, signs old tokens out and returns a working one', () => {
      const a = auth();
      const old = a.login('correct horse').token;
      const { token } = a.changePassword('correct horse', 'a brand new one');
      expect(() => a.verify(old)).toThrow(UnauthorizedError);
      expect(() => a.verify(token)).not.toThrow();
      expect(() => a.login('a brand new one')).not.toThrow();
      expect(() => a.login('correct horse')).toThrow(UnauthorizedError);
    });
    it('checks the old password', () => {
      expect(() => auth().changePassword('wrong', 'a brand new one')).toThrow(
        UnauthorizedError,
      );
    });
    it('enforces length and difference rules', () => {
      const a = auth();
      expect(() => a.changePassword('correct horse', 'short')).toThrow(
        ValidationError,
      );
      expect(() => a.changePassword('correct horse', 'x'.repeat(73))).toThrow(
        /72 bytes/,
      );
      expect(() => a.changePassword('correct horse', 'correct horse')).toThrow(
        /different/,
      );
    });
  });
});
