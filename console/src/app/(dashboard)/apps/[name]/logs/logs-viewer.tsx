'use client';

import { ArrowDownToLine, Download, Eraser, Pause, Play } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { SCOPED_BOX_FOCUS, scopedSelectAll } from '@/lib/scoped-select';

type Line = { id: number; text: string; stream: 'stdout' | 'stderr' };
type Status = 'connecting' | 'live' | 'paused' | 'ended' | 'failed';

const MAX_LINES = 2000;
// While you are reading or selecting, keep far more history so the lines under your cursor are not trimmed away
const MAX_LINES_WHILE_READING = 10000;
const MAX_FAILURES = 3;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const STATUS_BADGE: Record<
  Status,
  { label: string; variant: 'success' | 'warning' | 'default' | 'destructive' }
> = {
  connecting: { label: 'Connecting', variant: 'warning' },
  live: { label: 'Live', variant: 'success' },
  paused: { label: 'Paused', variant: 'default' },
  ended: { label: 'Stream ended', variant: 'default' },
  failed: { label: 'Disconnected', variant: 'destructive' },
};

// Memoized + keyed by id: appending a line leaves every existing row's DOM untouched, which keeps your selection
const LogRow = memo(function LogRow({
  text,
  stderr,
}: {
  text: string;
  stderr: boolean;
}) {
  return (
    <div
      className={
        stderr
          ? // the plain red of the theme is too faint on the log box in the light theme (contrast 4.3:1, needs 4.5:1; red-700 gives 5.8:1)
            'whitespace-pre-wrap text-red-700 dark:text-destructive'
          : 'whitespace-pre-wrap'
      }
    >
      {text || ' '}
    </div>
  );
});

export function LogsViewer({ appName }: { appName: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [attempt, setAttempt] = useState(0); // bump to force a fresh connection
  const nextId = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const holdRef = useRef(false); // mouse button is down inside the log (selecting)

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  useEffect(() => {
    const release = () => {
      holdRef.current = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  /** True while some text inside the log is selected. */
  function hasSelectionInside() {
    const sel = window.getSelection();
    const el = box.current;
    if (!sel || sel.isCollapsed || !el) return false;
    return (
      (!!sel.anchorNode && el.contains(sel.anchorNode)) ||
      (!!sel.focusNode && el.contains(sel.focusNode))
    );
  }

  useEffect(() => {
    if (paused) {
      setStatus('paused');
      return;
    }

    setStatus('connecting');
    const es = new EventSource(`/api/logs/${appName}`);
    let pending: Line[] = [];
    let frame = 0;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let first = true;

    // Lines arrive in bursts: render at most once per frame
    const flush = () => {
      frame = 0;
      const add = pending;
      pending = [];
      setLines((prev) => {
        const next = prev.concat(add);
        const limit = followRef.current ? MAX_LINES : MAX_LINES_WHILE_READING;
        return next.length > limit ? next.slice(-limit) : next;
      });
    };

    es.onopen = () => {
      failures = 0;
      setStatus('live');
      // A (re)connection replays the recent tail, so start from a clean slate
      if (!first) setLines([]);
      first = false;
    };
    es.onmessage = (e) => {
      const d = JSON.parse(e.data) as {
        line: string;
        stream: 'stdout' | 'stderr';
      };
      pending.push({
        id: nextId.current++,
        text: d.line.replace(ANSI, ''),
        stream: d.stream,
      });
      if (!frame) frame = requestAnimationFrame(flush);
    };
    es.addEventListener('end', () => {
      es.close();
      setStatus('ended');
    });
    es.onerror = () => {
      es.close();
      failures++;
      if (failures >= MAX_FAILURES) {
        setStatus('failed');
        return;
      }
      setStatus('connecting');
      retry = setTimeout(() => setAttempt((n) => n + 1), 2000 * failures);
    };

    return () => {
      es.close();
      if (frame) cancelAnimationFrame(frame);
      if (retry) clearTimeout(retry);
    };
  }, [appName, paused, attempt]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
  }, [lines, filter]);

  // Like a terminal: stick to the newest line, unless you are selecting text or have scrolled up.
  // New lines then keep arriving below without moving the view or touching the selection.
  useEffect(() => {
    if (!follow || !box.current) return;
    if (holdRef.current || hasSelectionInside()) {
      setFollow(false);
      return;
    }
    box.current.scrollTop = box.current.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, follow]);

  function download() {
    const blob = new Blob([lines.map((l) => l.text).join('\n') + '\n'], {
      type: 'text/plain',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${appName}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const badge = STATUS_BADGE[status];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <CardTitle>Runtime logs</CardTitle>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter log lines"
            className="h-8 w-40"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? (
              <Play className="h-4 w-4" />
            ) : (
              <Pause className="h-4 w-4" />
            )}
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLines([])}>
            <Eraser className="h-4 w-4" /> Clear
          </Button>
          <CopyButton
            value={() => shown.map((l) => l.text).join('\n')}
            disabled={shown.length === 0}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={lines.length === 0}
            onClick={download}
          >
            <Download className="h-4 w-4" /> Download
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {status === 'failed' && (
          <p role="alert" className="text-sm text-destructive">
            Could not keep the log stream open. You may be signed out, or
            Provelox is unreachable.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setPaused(false);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </p>
        )}
        <div className="relative">
          <div
            ref={box}
            role="log"
            aria-label="Runtime logs"
            {...scopedSelectAll}
            onPointerDown={() => {
              holdRef.current = true;
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              // Scrolling up stops following; scrolling back to the bottom resumes it
              setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
            }}
            className={`h-128 overflow-auto rounded-sm bg-muted p-3 font-mono text-xs leading-relaxed ${SCOPED_BOX_FOCUS}`}
          >
            {shown.length === 0 ? (
              <span className="text-muted-foreground">
                {lines.length > 0
                  ? 'No lines match the filter.'
                  : status === 'live'
                    ? 'Waiting for output…'
                    : ''}
              </span>
            ) : (
              shown.map((l) => (
                <LogRow
                  key={l.id}
                  text={l.text}
                  stderr={l.stream === 'stderr'}
                />
              ))
            )}
          </div>
          {!follow && (
            <Button
              size="sm"
              className="absolute bottom-3 right-5 shadow-sm"
              onClick={() => {
                setFollow(true);
                if (box.current)
                  box.current.scrollTop = box.current.scrollHeight;
              }}
            >
              <ArrowDownToLine className="h-4 w-4" /> Latest
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Showing the last {MAX_LINES.toLocaleString()} lines (more while you
          are scrolled up). Scrolling up or selecting text freezes the view
          while new lines keep arriving below. Click Latest to follow again. Red
          lines were written to stderr. Press Ctrl/Cmd+A inside the log to
          select all of it, or use Copy.
        </p>
      </CardContent>
    </Card>
  );
}
