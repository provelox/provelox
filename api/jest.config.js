/** Unit tests run everywhere; tests that need a Docker engine are *.docker.spec.ts and opt in with PVX_DOCKER_TESTS=1. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: process.env.PVX_DOCKER_TESTS ? [] : ['\\.docker\\.spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: true }] },
};
