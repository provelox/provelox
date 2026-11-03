'use client';

import {
  Copy,
  Eye,
  EyeOff,
  FileText,
  MoreHorizontal,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatEnv, mergeEnv, parseEnv, type ParseProblem } from '@/lib/dotenv';
import { useUpdateApp } from '../use-update-app';

type Row = { key: string; value: string };
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function EnvEditor({
  appName,
  initial,
}: {
  appName: string;
  initial: Row[];
}) {
  const { update, pending: busy } = useUpdateApp(appName);
  const [rows, setRows] = useState<Row[]>(initial);
  const [revealed, setRevealed] = useState(false);
  // Bulk editing: the variables as a .env text, and an import from pasted text or a file
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState('');
  const [textProblems, setTextProblems] = useState<ParseProblem[]>([]);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const fileInput = useRef<HTMLInputElement>(null);

  const keys = rows.map((r) => r.key);
  const invalid = rows.some(
    (r, i) => !KEY_RE.test(r.key) || keys.indexOf(r.key) !== i,
  );
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);

  const preview = pasted.trim() ? parseEnv(pasted) : null;
  const merged = preview ? mergeEnv(rows, preview.rows, mode) : null;

  function openText() {
    setText(formatEnv(rows));
    setTextProblems([]);
    setRevealed(true);
    setTextMode(true);
  }

  /** Takes the text back into the rows, ready to save. Nothing is lost if it cannot be read: it stays as text. */
  function closeText() {
    const r = parseEnv(text);
    if (r.problems.length > 0) {
      setTextProblems(r.problems);
      return;
    }
    setRows(r.rows);
    setTextMode(false);
  }

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Card>
      <CardHeader className="flex-col sm:flex-row items-start justify-between">
        <div>
          <CardTitle>Environment variables</CardTitle>
          <CardDescription>
            Saving restarts the app with the new values. Values are hidden by
            default.
          </CardDescription>
        </div>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (textMode ? closeText() : openText())}
          >
            <FileText className="h-4 w-4" />
            {textMode ? 'Back to the list' : 'Edit as text'}
          </Button>
          {!textMode && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={revealed ? 'Hide values' : 'Reveal values'}
              title={revealed ? 'Hide values' : 'Reveal values'}
              aria-pressed={revealed}
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          )}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setImporting(true)}>
                <Upload className="h-4 w-4" /> Import…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={rows.length === 0 || textMode}
                onSelect={() =>
                  void navigator.clipboard
                    .writeText(formatEnv(rows))
                    .then(() => toast.success('Copied as .env'))
                    .catch(() => toast.error('Could not copy'))
                }
              >
                <Copy className="h-4 w-4" /> Copy as .env
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {textMode && (
          <>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setTextProblems([]);
              }}
              spellCheck={false}
              autoComplete="off"
              aria-label="Variables as text"
              placeholder={
                'NAME=value\n# comments and blank lines are fine\nKEY="a value with spaces"'
              }
              className="min-h-64 w-full rounded-md border bg-background p-3 font-mono text-xs"
            />
            {textProblems.length > 0 && (
              <ul role="alert" className="text-xs text-destructive">
                {textProblems.map((p, i) => (
                  <li key={i}>
                    {p.line > 0 ? `Line ${p.line}: ` : ''}
                    {p.message}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              One NAME=value per line, like a .env file. Quote a value that has
              spaces; a quoted value may run over several lines. Press{' '}
              <strong>Back to the list</strong> to check it, then{' '}
              <strong>Save changes</strong>.
            </p>
          </>
        )}
        {!textMode && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No variables set.</p>
        )}
        {!textMode &&
          rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={r.key}
                onChange={(e) => set(i, { key: e.target.value })}
                placeholder="KEY"
                className="w-56 font-mono"
                aria-label={`Variable ${i + 1} name`}
                aria-invalid={!KEY_RE.test(r.key) || keys.indexOf(r.key) !== i}
              />
              <Input
                value={r.value}
                onChange={(e) => set(i, { value: e.target.value })}
                type={revealed ? 'text' : 'password'}
                autoComplete="off"
                placeholder="value"
                className="font-mono"
                aria-label={`Variable ${i + 1} value`}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label="Remove"
                onClick={() =>
                  setRows((rs) => rs.filter((_, idx) => idx !== i))
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        {!textMode && invalid && (
          <p className="text-xs text-destructive">
            Names must be unique and look like MY_VAR.
          </p>
        )}
        <div className="mt-2 flex gap-2">
          {!textMode && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRows((rs) => [...rs, { key: '', value: '' }])}
            >
              <Plus className="h-4 w-4" /> Add variable
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy || (textMode ? false : invalid || !dirty)}
            onClick={() => {
              if (textMode) {
                const r = parseEnv(text);
                if (r.problems.length > 0) return setTextProblems(r.problems);
                setRows(r.rows);
                setTextMode(false);
                if (JSON.stringify(r.rows) === JSON.stringify(initial)) return;
                return update({ envVars: r.rows }, 'Environment saved');
              }
              update({ envVars: rows }, 'Environment saved');
            }}
          >
            Save changes
          </Button>
        </div>
      </CardContent>

      <Dialog open={importing} onOpenChange={(o) => !o && setImporting(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import variables</DialogTitle>
            <DialogDescription>
              Paste a .env file or a JSON object, or choose a file. Nothing is
              saved yet: the result appears in the list for you to check, then
              save.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Variables to import"
            placeholder={'DB_HOST=db\nDB_PASSWORD="s3cret value"'}
            className="min-h-40 w-full rounded-md border bg-background p-3 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept=".env,.txt,.json,text/plain,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 1024 * 1024)
                  return void toast.error(
                    'That file is too big (1 MB at most).',
                  );
                setPasted(await f.text());
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="h-4 w-4" /> Choose a file…
            </Button>
            <fieldset className="flex items-center gap-3 text-sm">
              <legend className="sr-only">What to do with them</legend>
              {(
                [
                  ['merge', 'Add and update (keep the others)'],
                  ['replace', 'Replace everything'],
                ] as const
              ).map(([id, label]) => (
                <label key={id} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="env-import-mode"
                    className="accent-primary"
                    checked={mode === id}
                    onChange={() => setMode(id)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          </div>
          {preview && (
            <div className="flex flex-col gap-1.5 rounded-md border p-3 text-sm">
              {preview.problems.length > 0 && (
                <ul role="alert" className="text-xs text-destructive">
                  {preview.problems.map((p, i) => (
                    <li key={i}>
                      {p.line > 0 ? `Line ${p.line}: ` : ''}
                      {p.message}
                    </li>
                  ))}
                </ul>
              )}
              {merged && (
                <>
                  <p>
                    <strong>{merged.summary.added.length}</strong> added,{' '}
                    <strong>{merged.summary.changed.length}</strong> changed,{' '}
                    {merged.summary.unchanged.length} the same
                    {mode === 'replace' && (
                      <>
                        , <strong>{merged.summary.removed.length}</strong>{' '}
                        removed
                      </>
                    )}
                    .
                  </p>
                  <p className="break-words font-mono text-xs text-muted-foreground">
                    {[
                      ...merged.summary.added.map((k) => `+ ${k}`),
                      ...merged.summary.changed.map((k) => `~ ${k}`),
                      ...merged.summary.removed.map((k) => `− ${k}`),
                    ].join('   ') || 'No difference.'}
                  </p>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImporting(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !preview ||
                preview.problems.length > 0 ||
                preview.rows.length === 0
              }
              onClick={() => {
                if (!merged) return;
                setRows(merged.rows);
                setTextMode(false);
                setImporting(false);
                setPasted('');
                toast.success('Imported. Check the list, then save.');
              }}
            >
              Add to the list
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
