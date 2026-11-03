'use client';

import { Layers, Library, Play, RotateCw, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { GroupsFile } from '@/lib/groups';
import type { AppRow } from './app-row';
import { planBulk, type BulkAction } from './bulk';

/** What can be done to the selected apps, floating at the bottom while a selection exists. */
export function BulkBar({
  selected,
  groups,
  busy,
  onRequest,
  onClear,
  onGroup,
}: {
  selected: AppRow[];
  groups: GroupsFile;
  busy: boolean;
  /** Ask to run an action: the page confirms it first, listing what will and will not be touched */
  onRequest: (action: BulkAction, groupId?: string | null) => void;
  onClear: () => void;
  /** Move the selected apps that are not in a project into one */
  onGroup: () => void;
}) {
  if (selected.length === 0) return null;
  const count = (a: BulkAction) => planBulk(a, selected).apply.length;
  const Action = ({
    action,
    icon,
    label,
  }: {
    action: Exclude<BulkAction, 'move'>;
    icon: React.ReactNode;
    label: string;
  }) => (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || count(action) === 0}
      onClick={() => onRequest(action)}
    >
      {icon} {label}{' '}
      <span className="text-muted-foreground">{count(action)}</span>
    </Button>
  );

  return (
    <div
      role="region"
      aria-label="Actions for the selected apps"
      className="fixed bottom-5 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-lg lg:left-[calc(50%+7.5rem)]"
    >
      <span className="px-1 text-sm font-medium">
        {selected.length} selected
      </span>
      <Action
        action="restart"
        icon={<RotateCw className="h-4 w-4" />}
        label="Restart"
      />
      <Action
        action="stop"
        icon={<Square className="h-4 w-4" />}
        label="Stop"
      />
      <Action
        action="start"
        icon={<Play className="h-4 w-4" />}
        label="Start"
      />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || count('move') === 0}
          >
            <Library className="h-4 w-4" /> Move to collection{' '}
            <span className="text-muted-foreground">{count('move')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="w-48">
          {[...groups.groups]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((g) => (
              <DropdownMenuItem
                key={g.id}
                onSelect={() => onRequest('move', g.id)}
              >
                {g.name}
              </DropdownMenuItem>
            ))}
          {groups.groups.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => onRequest('move', null)}>
            No group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || selected.every((r) => r.project)}
        title="Move apps that are not in a project into one, keeping their data"
        onClick={onGroup}
      >
        <Layers className="h-4 w-4" /> Group into a project{' '}
        <span className="text-muted-foreground">
          {selected.filter((r) => !r.project).length}
        </span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
