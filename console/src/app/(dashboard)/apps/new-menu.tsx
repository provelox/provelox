'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GroupAppsDialog } from '@/components/projects/group-apps';
import { Boxes, ChevronDown, Layers, LayoutTemplate, Plus } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Everything you can create from one place: an app, a ready-made template, or your own compose file. */
export function NewMenu() {
  const router = useRouter();
  const [grouping, setGrouping] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <Plus className="h-4 w-4" /> New <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem asChild className="items-start gap-3 py-2">
            <Link href="/apps?new=1">
              <Boxes className="mt-0.5 h-4 w-4" />
              <span>
                <span className="block font-medium">App</span>
                <span className="block text-xs text-muted-foreground">
                  One service, from an image you deploy.
                </span>
              </span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="items-start gap-3 py-2">
            <Link href="/templates">
              <LayoutTemplate className="mt-0.5 h-4 w-4" />
              <span>
                <span className="block font-medium">From a template</span>
                <span className="block text-xs text-muted-foreground">
                  A database, CMS or tool, ready to run.
                </span>
              </span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="items-start gap-3 py-2">
            <Link href="/apps?compose=1">
              <Layers className="mt-0.5 h-4 w-4" />
              <span>
                <span className="block font-medium">Compose project</span>
                <span className="block text-xs text-muted-foreground">
                  Several services from your own compose file.
                </span>
              </span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="items-start gap-3 py-2"
            onSelect={() => setGrouping(true)}
          >
            <Layers className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block font-medium">Group running apps</span>
              <span className="block text-xs text-muted-foreground">
                Move apps you already run into a project.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <GroupAppsDialog
        pick
        apps={grouping ? [] : null}
        onClose={() => {
          setGrouping(false);
          router.refresh();
        }}
      />
    </>
  );
}
