'use client';

import { ExternalLink } from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { ReleaseNote } from '@/lib/backend';
import { timeAgo } from '@/lib/format';
import { formatVersion } from '@/lib/version';

/**
 * The notes are the project's own text, but they come over the network, so they are treated as untrusted: raw HTML is
 * dropped, images are not loaded, and only https links work (they open in a new tab). What is left is plain structure:
 * headings, lists, emphasis, code and links.
 */
const components: Components = {
  h1: ({ children }) => (
    <h3 className="mt-4 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-4 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-4 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className="mt-3 text-sm font-medium first:mt-0">{children}</h5>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4" />,
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-4 hover:no-underline"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
};

/** Only https links are kept; anything else (javascript:, data:, a relative path) is left as plain text */
const safeUrl = (url: string) => (/^https:\/\//i.test(url) ? url : '');

/** What each release since the one running says about itself, newest first, with the newest open */
export function ReleaseNotes({
  notes,
  current,
}: {
  notes: ReleaseNote[];
  current: string | null;
}) {
  if (notes.length === 0) return null;
  return (
    <Card id="whats-new" data-testid="release-notes" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>What’s new</CardTitle>
        <CardDescription>
          {notes.length === 1
            ? `What changes from ${formatVersion(current)} to ${formatVersion(notes[0].version)}.`
            : `${notes.length} releases since ${formatVersion(current)}, newest first. Updating installs all of them.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {notes.map((n, i) => (
          <details
            key={n.version}
            open={i === 0}
            className="group rounded-lg border [&[open]>summary]:border-b"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 text-sm marker:hidden hover:bg-secondary/50 [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden="true"
                className="text-muted-foreground transition-transform duration-150 group-open:rotate-90"
              >
                ›
              </span>
              <span className="font-medium">{formatVersion(n.version)}</span>
              {n.publishedAt && (
                <span
                  className="text-xs text-muted-foreground"
                  suppressHydrationWarning
                >
                  {timeAgo(n.publishedAt)}
                </span>
              )}
              {n.url && (
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Open on GitHub <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </summary>
            <div className="max-h-[28rem] overflow-y-auto px-4 py-3 text-sm">
              {n.body ? (
                <Markdown
                  skipHtml
                  components={components}
                  urlTransform={safeUrl}
                >
                  {n.body}
                </Markdown>
              ) : (
                <p className="text-muted-foreground">
                  No notes were published for this release.
                </p>
              )}
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
