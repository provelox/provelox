'use client';

import {
  BookOpen,
  Download,
  GitBranch,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  addTemplateSourceAction,
  refreshTemplateSourceAction,
  removeTemplateSourceAction,
} from '@/actions/template-sources';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Section } from '@/components/section-nav';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { REGISTRY_EXAMPLES } from '@/lib/registry-examples';
import { timeAgo } from '@/lib/format';
import type { TemplateSource } from '@/lib/types';
import { cn } from '@/lib/utils';

type Kind = 'index' | 'git';

/** Hands a file to the browser as a download. */
function download(name: string, content: string) {
  const blob = new Blob([content], {
    type: name.endsWith('.json') ? 'application/json' : 'text/yaml',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.split('/').pop() ?? name;
  a.click();
  URL.revokeObjectURL(url);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** The registries Provelox reads templates from: the list, a form to add one, and how to make your own. */
export function TemplateRegistriesPanel({
  sources,
}: {
  sources: TemplateSource[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('index');
  const [exampleId, setExampleId] = useState(REGISTRY_EXAMPLES[0].id);
  const example =
    REGISTRY_EXAMPLES.find((e) => e.id === exampleId) ?? REGISTRY_EXAMPLES[0];
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const add = () =>
    startTransition(async () => {
      setError(undefined);
      const res = await addTemplateSourceAction({
        kind,
        url,
        name,
        ref,
        path,
        token,
      });
      if (!res.ok) return void setError(res.error);
      const n = res.data?.templates ?? 0;
      toast.success(
        `Added ${res.data?.name}: ${n} template${n === 1 ? '' : 's'}`,
      );
      for (const s of res.data?.skipped.slice(0, 3) ?? [])
        toast.warning(`${s.id} skipped: ${s.reason}`);
      setName('');
      setUrl('');
      setRef('');
      setPath('');
      setToken('');
      router.refresh();
    });

  const act = (s: TemplateSource, what: 'refresh' | 'remove') => {
    setBusy(s.id);
    startTransition(async () => {
      const res =
        what === 'refresh'
          ? await refreshTemplateSourceAction(s.id)
          : await removeTemplateSourceAction(s.id);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      if (what === 'remove') toast.success(`Removed ${s.name}`);
      else if (res.data && 'error' in res.data && res.data.error)
        toast.error(res.data.error);
      else toast.success(`${s.name} is up to date`);
      router.refresh();
    });
  };

  return (
    <>
      <Section id="registries">
        <Card>
          <CardHeader>
            <CardTitle>Your registries</CardTitle>
            <CardDescription>
              Templates from these appear on the Templates page next to the
              built-in ones, marked with where they came from. They are
              refreshed when you press the button, and in the background when
              more than six hours old.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sources.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No registries yet. Add one below, or start from an example in
                the guide.
              </p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {sources.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 p-3 text-sm">
                    {s.kind === 'git' ? (
                      <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {s.name}{' '}
                        <span className="font-normal text-muted-foreground">
                          {s.templates} template{s.templates === 1 ? '' : 's'}
                        </span>
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {s.url}
                        {s.kind === 'git' && ` · ${s.ref} · ${s.path}`}
                      </p>
                      <p
                        className={cn(
                          'text-xs',
                          s.error
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {s.error
                          ? `Last refresh failed: ${s.error}`
                          : s.syncedAt
                            ? `Updated ${timeAgo(s.syncedAt)}`
                            : 'Not read yet'}
                        {s.skipped.length > 0 &&
                          ` · ${s.skipped.length} skipped (${s.skipped[0].id}: ${s.skipped[0].reason})`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Refresh ${s.name}`}
                      disabled={pending}
                      onClick={() => act(s, 'refresh')}
                    >
                      {busy === s.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${s.name}`}
                      disabled={pending}
                      onClick={() => act(s, 'remove')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section id="add">
        <Card>
          <CardHeader>
            <CardTitle>Add a registry</CardTitle>
            <CardDescription>
              It is read before it is saved: if it cannot be read, or lists
              nothing usable, you are told why and nothing is added.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <div
                role="group"
                aria-label="Kind"
                className="flex gap-1 text-sm"
              >
                {(
                  [
                    ['index', 'Index file address'],
                    ['git', 'Git repository'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={cn(
                      'rounded-md border px-3 py-1',
                      kind === k
                        ? 'bg-secondary font-medium'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Field
                label={
                  kind === 'git' ? 'Repository address' : 'Index file address'
                }
                hint={
                  kind === 'git'
                    ? 'GitHub, GitLab, Bitbucket, Gitea or Forgejo, like https://github.com/acme/templates.'
                    : 'The address of a JSON or YAML file, like https://example.com/templates.json.'
                }
              >
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={
                    kind === 'git'
                      ? 'https://github.com/acme/templates'
                      : 'https://example.com/templates.json'
                  }
                />
              </Field>
              {kind === 'git' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Branch or tag" hint="Default: main">
                    <Input
                      value={ref}
                      onChange={(e) => setRef(e.target.value)}
                      placeholder="main"
                    />
                  </Field>
                  <Field label="File in the repository">
                    <Input
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="provelox-templates.json"
                    />
                  </Field>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Name (optional)">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field
                  label="Access token (private registries)"
                  hint="Stored encrypted. Sent only to this address."
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </Field>
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end">
                <Button type="submit" disabled={pending || !url.trim()}>
                  {pending && !busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Add registry
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </Section>

      <Section id="guide">
        <Card>
          <CardHeader>
            <CardTitle>Make your own registry</CardTitle>
            <CardDescription>
              A registry is one JSON or YAML file that lists templates. Its
              templates are deployed like a pasted Compose file, with the same
              checks, but they can run any image: share one only with people who
              trust you.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                Write a file called <code>provelox-templates.json</code> (or
                YAML) that lists your templates. Start from an example below.
              </li>
              <li>
                Put it where a plain <code>GET</code> can reach it: a GitHub or
                GitLab repository, a storage bucket, any web server. Private
                ones need an access token.
              </li>
              <li>
                Add its address here. Provelox reads it first and tells you what
                is wrong, or how many templates it found.
              </li>
            </ol>

            <div
              role="tablist"
              aria-label="Examples"
              className="flex flex-wrap gap-1"
            >
              {REGISTRY_EXAMPLES.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={example.id === e.id}
                  onClick={() => setExampleId(e.id)}
                  className={cn(
                    'rounded-md border px-3 py-1 text-xs',
                    example.id === e.id
                      ? 'bg-secondary font-medium text-foreground'
                      : 'hover:text-foreground',
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
            <p className="text-foreground">{example.summary}</p>

            {example.files.map((f) => (
              <div key={f.name} className="overflow-hidden rounded-md border">
                <div className="flex items-center justify-between gap-2 border-b bg-secondary/40 px-3 py-1.5">
                  <code className="text-xs text-foreground">{f.name}</code>
                  <div className="flex gap-1.5">
                    <CopyButton value={f.content} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => download(f.name, f.content)}
                    >
                      <Download className="h-4 w-4" /> Download
                    </Button>
                  </div>
                </div>
                <pre className="max-h-72 overflow-auto bg-muted p-3 font-mono text-xs text-foreground">
                  {f.content}
                </pre>
              </div>
            ))}

            <ul className="list-disc space-y-1 pl-5">
              {example.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p>
              Templates deploy like a pasted Compose file, with the same checks,
              but they can run any image: share a registry only with people who
              trust you. Every field is in the documentation under{' '}
              <em>Guide → Template registries</em>.
            </p>
          </CardContent>
        </Card>
      </Section>
    </>
  );
}
