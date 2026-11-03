'use client';

import { ChevronRight, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { generateSecret } from '@/lib/compose-vars';

export interface VariableField {
  key: string;
  label: string;
  description?: string;
  kind: 'text' | 'secret';
  minLength?: number;
}

/** A generated secret is long enough for the app, and never shorter than 32 characters */
export const secretFor = (f: Pick<VariableField, 'minLength'>) =>
  generateSecret(Math.max(32, f.minLength ?? 0));

export const tooShort = (f: VariableField, value: string | undefined) =>
  !!f.minLength && !!value && value.length < f.minLength;

/** One input per variable. Secrets are hidden, and can be revealed or replaced by a fresh random value. */
export function VariablesForm({
  fields,
  values,
  onChange,
  services,
}: {
  fields: VariableField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Which services use each variable. With it, a long list is grouped under the service that uses it first. */
  services?: Record<string, string[]>;
}) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  if (fields.length === 0) return null;

  const input = (f: VariableField) => (
    <Field
      key={f.key}
      field={f}
      value={values[f.key]}
      shown={!!shown[f.key]}
      alsoUsedBy={(services?.[f.key] ?? []).slice(1)}
      onToggle={() => setShown((s) => ({ ...s, [f.key]: !s[f.key] }))}
      onChange={(v) => onChange(f.key, v)}
    />
  );

  // Group by the first service that uses the variable; what no service uses goes last
  const groups = new Map<string, VariableField[]>();
  for (const f of fields) {
    const g = services?.[f.key]?.[0] ?? '';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  if (groups.size <= 1 && fields.length <= 6)
    return <div className="flex flex-col gap-3">{fields.map(input)}</div>;

  const ordered = [...groups.entries()].sort(
    ([a], [b]) => Number(a === '') - Number(b === ''),
  );
  return (
    <div className="flex flex-col gap-2">
      {ordered.map(([name, group]) => (
        <Group
          key={name}
          name={name || 'Other'}
          fields={group}
          values={values}
          // Open what still needs filling, and everything when there is only a little
          initiallyOpen={
            fields.length <= 6 || group.some((f) => !values[f.key])
          }
        >
          {group.map(input)}
        </Group>
      ))}
    </div>
  );
}

/** One service's variables, folded away once they are filled in. */
function Group({
  name,
  fields,
  values,
  initiallyOpen,
  children,
}: {
  name: string;
  fields: VariableField[];
  values: Record<string, string>;
  initiallyOpen: boolean;
  children: React.ReactNode;
}) {
  // Decided once: filling the last box must not fold the group while the person is typing in it
  const [open, setOpen] = useState(initiallyOpen);
  const empty = fields.filter((f) => !values[f.key]).length;
  const invalid = fields.some((f) => tooShort(f, values[f.key]));
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-md border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
        <span className="font-mono font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {fields.length} variable{fields.length === 1 ? '' : 's'}
        </span>
        {invalid ? (
          <span className="ml-auto text-xs text-destructive">check values</span>
        ) : empty > 0 ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {empty} empty
          </span>
        ) : null}
      </summary>
      <div className="flex flex-col gap-3 border-t p-3">{children}</div>
    </details>
  );
}

function Field({
  field: f,
  value,
  shown,
  alsoUsedBy,
  onToggle,
  onChange,
}: {
  field: VariableField;
  value: string | undefined;
  shown: boolean;
  alsoUsedBy: string[];
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`var-${f.key}`} className="text-sm font-medium">
        {f.label}
      </label>
      <div className="flex max-w-md gap-2">
        <Input
          id={`var-${f.key}`}
          type={f.kind === 'secret' && !shown ? 'password' : 'text'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        {f.kind === 'secret' && (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={shown ? `Hide ${f.label}` : `Show ${f.label}`}
              onClick={onToggle}
            >
              {shown ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Generate a new ${f.label}`}
              title="Generate a new random value"
              onClick={() => onChange(secretFor(f))}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
      {tooShort(f, value) && (
        <p role="alert" className="text-xs text-destructive">
          Must be at least {f.minLength} characters (now {value?.length}). Use
          the refresh button to generate one.
        </p>
      )}
      {f.description && (
        <p className="text-xs text-muted-foreground">{f.description}</p>
      )}
      {alsoUsedBy.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Also used by {alsoUsedBy.join(', ')}.
        </p>
      )}
    </div>
  );
}
