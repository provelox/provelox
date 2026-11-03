'use client';

import { Pin } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { recordVisit, useFavorites } from '@/lib/use-favorites';
import { cn } from '@/lib/utils';

/** A star beside an app's name: pins it to the sidebar. Also notes the visit, so "Recent" fills itself. */
export function PinButton({ appName }: { appName: string }) {
  const { pinned, toggle } = useFavorites();
  useEffect(() => recordVisit(appName), [appName]);
  const on = pinned.includes(appName);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 coarse:h-11 coarse:w-11"
      aria-label={on ? `Unpin ${appName}` : `Pin ${appName} to the sidebar`}
      aria-pressed={on}
      title={on ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
      onClick={() => toggle(appName)}
    >
      <Pin
        className={cn(
          'h-3.5 w-3.5',
          on ? 'fill-primary text-primary' : 'text-muted-foreground',
        )}
      />
    </Button>
  );
}
