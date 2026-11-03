// Keep test output readable: Nest's logger is noisy
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);
