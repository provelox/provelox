'use client';

import { TriangleAlert } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { volumeDownloadUrl } from '@/lib/volume-download';

/**
 * What to do with what is already in the volume, shared by the two ways to restore (an upload from the browser, a file
 * on the server): only into an empty volume, or replace it, which needs the app's name typed and points to a copy first.
 */
export function RestoreModeFields({
  appName,
  volumeName,
  mode,
  onMode,
  typed,
  onTyped,
  busy,
  /** What happens if the restore stops half way, in words that fit how the file gets there */
  halfWay,
}: {
  appName: string;
  volumeName: string;
  mode: 'empty' | 'replace';
  onMode: (m: 'empty' | 'replace') => void;
  typed: string;
  onTyped: (v: string) => void;
  busy: boolean;
  halfWay: string;
}) {
  const replace = mode === 'replace';
  return (
    <>
      <RadioGroup
        value={mode}
        onValueChange={(v) => onMode(v as 'empty' | 'replace')}
        className="flex flex-col gap-2"
        aria-label="What to do with what is in the volume"
        disabled={busy}
      >
        {(
          [
            [
              'empty',
              'Only if the volume is empty',
              'Refused when something is already there, so nothing is mixed or lost.',
            ],
            [
              'replace',
              'Replace what is there',
              'Removes everything in the volume first, then restores the file.',
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <label
            key={value}
            className="flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm has-[:checked]:border-primary"
          >
            <span className="flex items-center gap-2 font-medium">
              <RadioGroupItem value={value} />
              {label}
            </span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </label>
        ))}
      </RadioGroup>

      {replace && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs"
        >
          <p className="flex gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <span>
              Everything in <span className="font-mono">{volumeName}</span> is
              deleted first and cannot be brought back. {halfWay}{' '}
              <a
                href={volumeDownloadUrl(appName, volumeName, false)}
                target="_blank"
                rel="noopener"
                className="font-medium underline underline-offset-2"
              >
                Download a copy first
              </a>
              .
            </span>
          </p>
          <label className="flex flex-col gap-1">
            <span>
              Type <span className="font-mono font-medium">{appName}</span> to
              confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => onTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-label="Type the name of the app to confirm"
            />
          </label>
        </div>
      )}
    </>
  );
}
