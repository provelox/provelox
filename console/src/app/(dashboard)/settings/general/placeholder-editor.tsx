'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setPlaceholderPageAction } from '@/actions/apps';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const EXAMPLE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Coming soon</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #111; color: #f5f5f5; }
      main { text-align: center; padding: 2rem; max-width: 32rem; }
      p { color: #a3a3a3; }
    </style>
  </head>
  <body>
    <main>
      <h1>Coming soon</h1>
      <p>This app has been created but nothing has been deployed to it yet.</p>
    </main>
  </body>
</html>
`;

export function PlaceholderEditor({ initial }: { initial: string }) {
  const [html, setHtml] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [showPreview, setShowPreview] = useState(false);
  const [pending, startTransition] = useTransition();

  function save(value: string) {
    startTransition(async () => {
      const res = await setPlaceholderPageAction(value);
      if (res.ok) {
        setHtml(value);
        setSaved(value);
        toast.success(
          value.trim()
            ? 'Placeholder page saved'
            : 'Back to the Provelox default',
        );
      } else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Placeholder page</CardTitle>
        <CardDescription>
          Shown on every app that has been created but not deployed yet
          (&ldquo;Your app will be here!&rdquo;). It replaces that page for all
          apps at once, and disappears per app as soon as something is deployed.
          Make the page self-contained (inline CSS, data URIs): other files are
          not served. Leave it empty for Provelox&apos;s default.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          spellCheck={false}
          rows={14}
          aria-label="Placeholder page HTML"
          placeholder="<html>…</html>"
          className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        />
        {html.length > 100 * 1024 && (
          <p className="text-xs text-destructive">
            The page can be at most 100 KB.
          </p>
        )}
        {showPreview && html.trim() && (
          // Fully sandboxed: no scripts, no same-origin access
          <iframe
            title="Placeholder page preview"
            sandbox=""
            srcDoc={html}
            className="h-80 w-full rounded-md border bg-white"
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending || html === saved || html.length > 100 * 1024}
            onClick={() => save(html)}
          >
            Save page
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!html.trim()}
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? 'Hide preview' : 'Preview'}
          </Button>
          {!html.trim() && (
            <Button variant="ghost" size="sm" onClick={() => setHtml(EXAMPLE)}>
              Use example
            </Button>
          )}
          {saved.trim() && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => save('')}
            >
              Restore Provelox default
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
