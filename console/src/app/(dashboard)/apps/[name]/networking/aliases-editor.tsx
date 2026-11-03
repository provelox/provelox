'use client';

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { aliasProblem } from '@/lib/alias';
import { useUpdateApp } from '../use-update-app';

/**
 * Extra names other apps can reach this one by, on top of its own. For an app moved from another platform that keeps the
 * names its neighbours already use (CapRover's srv-captain--name), or any second name you want to give a service.
 */
export function AliasesEditor({
  appName,
  initial,
}: {
  appName: string;
  initial: string[];
}) {
  const { update, pending } = useUpdateApp(appName);
  const [names, setNames] = useState(initial);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(names) !== JSON.stringify(initial);

  function add() {
    const v = draft.trim();
    const why = aliasProblem(v, names, appName);
    if (why) return setError(why);
    setNames([...names, v]);
    setDraft('');
    setError(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Other names</CardTitle>
        <CardDescription>
          More names other apps on this instance can use to reach it. An app
          moved from CapRover keeps its old name here, for example{' '}
          <code>srv-captain--{appName}</code>, so apps that still call it by
          that name keep working.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {names.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other names.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {names.map((n) => (
              <li
                key={n}
                className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 font-mono text-xs"
              >
                {n}
                <button
                  type="button"
                  aria-label={`Remove ${n}`}
                  onClick={() => setNames(names.filter((x) => x !== n))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex max-w-xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder={`srv-captain--${appName}`}
            aria-label="New name"
            aria-invalid={!!error}
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            disabled={pending || !dirty}
            onClick={() =>
              update(
                { aliases: names },
                'Saved. The app restarts to take the new names.',
              )
            }
          >
            Save names
          </Button>
          {dirty && (
            <span className="text-xs text-muted-foreground">
              Saving restarts the app.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
