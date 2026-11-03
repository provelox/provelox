'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setErrorPagesAction } from '@/actions/apps';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type Code = '502' | '503' | '504';
type Pages = Partial<Record<Code, string>>;

const CODES: { code: Code; title: string; hint: string }[] = [
  {
    code: '502',
    title: '502 Bad Gateway',
    hint: 'The app is down, restarting or crashing.',
  },
  {
    code: '503',
    title: '503 Service Unavailable',
    hint: 'The app is up but refusing requests (e.g. maintenance).',
  },
  {
    code: '504',
    title: '504 Gateway Timeout',
    hint: 'The app took too long to answer.',
  },
];

const EXAMPLE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>We'll be right back</title>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #fafafa; color: #222; }
      main { text-align: center; padding: 2rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>We'll be right back</h1>
      <p>We're doing a bit of maintenance. Please try again in a few minutes.</p>
    </main>
  </body>
</html>
`;

export function ErrorPagesEditor({
  appName,
  initial,
}: {
  appName: string;
  initial: Pages;
}) {
  const [pages, setPages] = useState<Pages>(initial);
  const [preview, setPreview] = useState<Code | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = CODES.some(
    ({ code }) => (pages[code] ?? '') !== (initial[code] ?? ''),
  );

  function save() {
    startTransition(async () => {
      const res = await setErrorPagesAction(appName, {
        '502': pages['502'] ?? '',
        '503': pages['503'] ?? '',
        '504': pages['504'] ?? '',
      });
      if (res.ok) toast.success('Error pages saved');
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom error pages</CardTitle>
        <CardDescription>
          Shown when the app can&apos;t answer, and also when it returns a 502,
          503 or 504 itself. Leave a page empty to keep Provelox&apos;s default
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {CODES.map(({ code, title, hint }) => (
          <div key={code} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <label htmlFor={`page-${code}`} className="text-sm font-medium">
                  {title}
                </label>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {!pages[code] && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPages((p) => ({ ...p, [code]: EXAMPLE }))}
                  >
                    Use example
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!pages[code]}
                  onClick={() => setPreview((c) => (c === code ? null : code))}
                >
                  {preview === code ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  Preview
                </Button>
              </div>
            </div>
            <textarea
              id={`page-${code}`}
              value={pages[code] ?? ''}
              onChange={(e) =>
                setPages((p) => ({ ...p, [code]: e.target.value }))
              }
              spellCheck={false}
              rows={6}
              placeholder="<html>…</html>"
              className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
            {(pages[code] ?? '').length > 100 * 1024 && (
              <p className="text-xs text-destructive">
                Pages can be at most 100 KB.
              </p>
            )}
            {preview === code && pages[code] && (
              // Fully sandboxed: no scripts, no same-origin access
              <iframe
                title={`${code} preview`}
                sandbox=""
                srcDoc={pages[code]}
                className="h-64 w-full rounded-md border bg-white"
              />
            )}
          </div>
        ))}
        <div>
          <Button size="sm" disabled={pending || !dirty} onClick={save}>
            Save error pages
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
