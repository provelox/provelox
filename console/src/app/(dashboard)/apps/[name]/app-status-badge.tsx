import { Badge } from '@/components/ui/badge';
import type { AppDefinition } from '@/lib/types';
import { statusOf, type AppStatus } from '../app-row';

const LABEL: Record<AppStatus, string> = {
  running: 'Running',
  starting: 'Starting',
  failed: 'Failing',
  unhealthy: 'Unhealthy',
  stopped: 'Stopped',
  building: 'Deploying',
};

const VARIANT: Record<
  AppStatus,
  'success' | 'warning' | 'destructive' | 'default'
> = {
  running: 'success',
  starting: 'warning',
  building: 'warning',
  failed: 'destructive',
  unhealthy: 'destructive',
  stopped: 'default',
};

export const appStatus = (app: AppDefinition): AppStatus =>
  statusOf({
    building: !!app.isAppBuilding,
    instanceCount: app.instanceCount,
    runState: app.runState,
    health: app.runStatus?.health,
  });

export function AppStatusBadge({ app }: { app: AppDefinition }) {
  const s = appStatus(app);
  return <Badge variant={VARIANT[s]}>{LABEL[s]}</Badge>;
}
