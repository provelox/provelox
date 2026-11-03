'use client';

import {
  Globe,
  Loader2,
  MoreHorizontal,
  Search,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { getTemplateAction } from '@/actions/projects';
import {
  DeployProjectDialog,
  type DeployMode,
} from '@/components/projects/deploy-project-dialog';
import { BrandTile } from '@/components/brand-tile';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Combobox } from '@/components/ui/combobox';
import type { Template, TemplateSource } from '@/lib/types';

export function TemplatesBrowser({
  templates,
  sources,
  existingProjects,
}: {
  templates: Template[];
  sources: TemplateSource[];
  existingProjects: string[];
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [mode, setMode] = useState<DeployMode | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  // 'all', 'builtin', or a registry's id
  const [source, setSource] = useState('all');
  const [, startTransition] = useTransition();

  const categories = useMemo(
    () => [...new Set(templates.map((t) => t.category))].sort(),
    [templates],
  );
  const shown = templates.filter(
    (t) =>
      (!category || t.category === category) &&
      (source === 'all' ||
        (source === 'builtin' ? !t.source : t.source?.id === source)) &&
      (!query ||
        `${t.name} ${t.description} ${t.category}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );

  function pick(t: Template) {
    setLoading(t.id);
    startTransition(async () => {
      const res = await getTemplateAction(t.id);
      setLoading(null);
      if (!res.ok || !res.data)
        return void toast.error(
          res.ok ? 'Could not load the template' : res.error,
        );
      setMode({ kind: 'template', template: t, compose: res.data.compose });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            aria-label="Search templates"
            className="pl-9"
          />
        </div>
        <Combobox
          value={category ?? 'all'}
          onValueChange={(v) => setCategory(v === 'all' ? null : v)}
          aria-label="Category"
          className="w-44"
          options={[
            { value: 'all', label: 'All categories' },
            ...categories.map((c) => ({ value: c, label: c })),
          ]}
        />
        {sources.length > 0 && (
          <Combobox
            value={source}
            onValueChange={setSource}
            aria-label="Registry"
            className="w-44"
            options={[
              { value: 'all', label: 'All registries' },
              { value: 'builtin', label: 'Built-in' },
              ...sources.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {shown.length} template{shown.length === 1 ? '' : 's'}
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              aria-label="More actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem asChild>
              <Link href="/settings/template-registries">
                <Settings2 className="h-4 w-4" /> Manage template registries
                {sources.length > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {sources.length}
                  </span>
                )}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {shown.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No template matches.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t)}
              disabled={loading !== null}
              className="group text-left"
              title={`Deploy ${t.name}`}
            >
              <Card className="flex h-full flex-row gap-3 p-4 transition-colors group-hover:border-primary/60">
                <BrandTile
                  slug={t.icon ?? t.id.split(':').pop()}
                  name={t.name}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    {loading === t.id && (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {t.description}
                  </p>
                  <p className="mt-auto flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                    {t.category}
                    {t.source && <> · {t.source.name}</>}
                    {t.publicWeb && (
                      <span
                        className="ml-auto inline-flex items-center gap-1"
                        title="Comes with a web address"
                      >
                        <Globe className="h-3 w-3" /> web
                      </span>
                    )}
                  </p>
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}

      <DeployProjectDialog
        mode={mode}
        existingProjects={existingProjects}
        onClose={() => setMode(null)}
      />
    </div>
  );
}
