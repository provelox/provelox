import { test as base, expect } from '@playwright/test';

export const test = base.extend({});
export { expect };
export type { Page } from '@playwright/test';

/** A name no real app has, so a failed run can never be mistaken for something to keep. */
export const throwawayName = () => `e2e-${Date.now().toString(36)}`;
