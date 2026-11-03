import { describe, expect, it } from 'vitest';
import {
  appDeleteEffects,
  groupDeleteEffects,
  projectRemoveEffects,
} from '@/lib/delete-effects';

describe('deleting an app', () => {
  it('says what goes: service, addresses, keys, secrets; and what stays: the data volumes', () => {
    const e = appDeleteEffects({
      domains: 2,
      defaultAddress: true,
      secrets: 1,
      volumes: ['pvx-shop-data'],
    });
    const goes = e.goes.join('\n');
    expect(goes).toMatch(/service/);
    expect(goes).toMatch(/3 addresses/);
    expect(goes).toMatch(/2 custom domains/);
    expect(goes).toMatch(/deploy keys/);
    expect(goes).toMatch(/1 secret,/);
    expect(e.stays[0]).toMatch(/1 data volume \(pvx-shop-data\)/);
    expect(e.stays[0]).toMatch(/Settings → Infrastructure/);
  });

  it('leaves out what the app does not have', () => {
    const e = appDeleteEffects({
      domains: 0,
      defaultAddress: false,
      secrets: 0,
      volumes: [],
    });
    const goes = e.goes.join('\n');
    expect(goes).not.toMatch(/address/);
    expect(goes).not.toMatch(/secret/);
    expect(e.stays[0]).toMatch(/no data volumes/);
  });

  it('counts one address in the singular', () => {
    const e = appDeleteEffects({
      domains: 0,
      defaultAddress: true,
      secrets: 0,
      volumes: [],
    });
    expect(e.goes.join('\n')).toMatch(/1 address it answers on:/);
  });
});

describe('deleting a collection', () => {
  it('only removes the grouping; its apps stay', () => {
    expect(groupDeleteEffects({ apps: 3 }).stays[0]).toMatch(
      /3 apps stay and are no longer in a collection/,
    );
    expect(groupDeleteEffects({ apps: 1 }).stays[0]).toMatch(
      /1 app stays and is no longer/,
    );
    expect(groupDeleteEffects({ apps: 0 }).stays).toEqual(['It has no apps.']);
  });
});

describe('removing a project', () => {
  it('keeps the data unless told otherwise', () => {
    const kept = projectRemoveEffects({
      services: ['web', 'db'],
      deleteData: false,
    });
    expect(kept.goes.join('\n')).toMatch(/2 services \(web, db\)/);
    expect(kept.goes.join('\n')).not.toMatch(/erased/);
    expect(kept.stays[0]).toMatch(/data volumes, kept/);
    const wiped = projectRemoveEffects({
      services: ['web'],
      deleteData: true,
    });
    expect(wiped.goes.join('\n')).toMatch(/erased for good/);
    expect(wiped.stays[0]).toMatch(/Nothing is kept/);
  });
});
