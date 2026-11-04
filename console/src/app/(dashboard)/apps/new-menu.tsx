'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GroupAppsDialog } from '@/components/projects/group-apps';
import {
  Boxes,
  ChevronDown,
  FileCode2,
  FolderInput,
  LayoutTemplate,
  Plus,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Everything you can create from one place: an app, a ready-made template, or your own compose file; and, set apart,
 * the one thing that tidies what you already run. The shortcuts shown are the real ones (see lib/shortcuts.ts).
 */
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
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Create
          </DropdownMenuLabel>
          <Entry
            href="/apps?new=1"
            icon={Boxes}
            title="App"
            hint="One container image, deployed as an app."
            keys="N"
          />
          <Entry
            href="/templates"
            icon={LayoutTemplate}
            title="From a template"
            hint="Databases, CMSs, AI tools: ready to run."
            keys="G T"
          />
          <Entry
            href="/apps?compose=1"
            icon={FileCode2}
            title="Compose project"
            hint="Several services from your own compose file."
          />
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Organize
          </DropdownMenuLabel>
          <Entry
            icon={FolderInput}
            title="Group running apps"
            hint="Move apps you already run into one project."
            onSelect={() => setGrouping(true)}
          />
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

/** One row: what it makes, why you would pick it, and its keyboard shortcut when it has one. */
function Entry({
  icon: Icon,
  title,
  hint,
  keys,
  href,
  onSelect,
}: {
  icon: typeof Boxes;
  title: string;
  hint: string;
  keys?: string;
  href?: string;
  onSelect?: () => void;
}) {
  const content = (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {keys && (
        <DropdownMenuShortcut aria-hidden="true" className="mt-0.5">
          {keys}
        </DropdownMenuShortcut>
      )}
    </>
  );
  return (
    <DropdownMenuItem
      asChild={!!href}
      className="items-start gap-3 py-2"
      onSelect={onSelect}
    >
      {href ? <Link href={href}>{content}</Link> : content}
    </DropdownMenuItem>
  );
}
