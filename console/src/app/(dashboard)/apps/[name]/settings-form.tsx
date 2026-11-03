'use client';

import { useOptimistic, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { AppDefinition } from '@/lib/types';
import { useUpdateApp } from './use-update-app';

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsForm({ app }: { app: AppDefinition }) {
  const { update, pending: busy } = useUpdateApp(app.appName);
  const [view, applyOptimistic] = useOptimistic(
    app,
    (cur, patch: Partial<AppDefinition>) => ({ ...cur, ...patch }),
  );
  const [instances, setInstances] = useState(String(app.instanceCount));
  const [port, setPort] = useState(String(app.containerHttpPort ?? 80));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Runtime</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {app.hasPersistentData ? (
            // An app that keeps data runs exactly one instance: two would write to the same volume
            <Row
              title="Running"
              hint="Apps that keep data run a single instance, so they can't be scaled out."
            >
              <Switch
                checked={view.instanceCount > 0}
                disabled={busy}
                aria-label="Running"
                onCheckedChange={(on) =>
                  update(
                    { instanceCount: on ? 1 : 0 },
                    on ? 'Started' : 'Stopped',
                    () => applyOptimistic({ instanceCount: on ? 1 : 0 }),
                  )
                }
              />
            </Row>
          ) : (
            <Row title="Instances" hint="Set to 0 to stop the app">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  update({ instanceCount: Number(instances) });
                }}
              >
                <Input
                  type="number"
                  min={0}
                  max={50}
                  value={instances}
                  onChange={(e) => setInstances(e.target.value)}
                  className="w-20"
                  aria-label="Instances"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={busy || Number(instances) === app.instanceCount}
                >
                  Save
                </Button>
              </form>
            </Row>
          )}
          {!app.notExposeAsWebApp && (
            <Row title="Container HTTP port">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  update({ containerHttpPort: Number(port) });
                }}
              >
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="w-24"
                  aria-label="Container HTTP port"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={
                    busy || Number(port) === (app.containerHttpPort ?? 80)
                  }
                >
                  Save
                </Button>
              </form>
            </Row>
          )}
        </CardContent>
      </Card>
    </>
  );
}
