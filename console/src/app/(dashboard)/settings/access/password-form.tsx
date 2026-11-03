'use client';

import { Check, Circle, KeyRound } from 'lucide-react';
import { useActionState, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  changePasswordAction,
  type ChangePasswordState,
} from '@/actions/security';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/password-rules';

function Rule({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li
      className={`flex items-center gap-2 text-xs ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
    >
      {ok ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Circle className="h-3.5 w-3.5" />
      )}
      {children}
    </li>
  );
}

export function PasswordForm() {
  const [state, action] = useActionState<ChangePasswordState, FormData>(
    changePasswordAction,
    {},
  );
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  // Closed until asked for: three empty password fields should not sit on the page all day
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (state.done) {
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
      setEditing(false);
    }
  }, [state]);

  function cancel() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setEditing(false);
  }

  const lengthOk =
    next.length >= MIN_PASSWORD_LENGTH && next.length <= MAX_PASSWORD_LENGTH;
  const differs = next.length > 0 && next !== current;
  const matches = next.length > 0 && next === confirm;

  return (
    <Card>
      <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Password</CardTitle>
          <CardDescription>
            This is the password for this console and the API. Changing it signs
            out every other session. CI deploy keys are not affected.
          </CardDescription>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <KeyRound className="h-4 w-4" /> Change password
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!editing && (
          <div className="flex flex-col gap-2">
            <p className="font-mono text-sm tracking-widest text-muted-foreground">
              ••••••••••••
            </p>
            {state.done && (
              <p
                role="status"
                className="text-sm text-emerald-600 dark:text-emerald-400"
              >
                Password changed. You are still signed in here; everything else
                was signed out.
              </p>
            )}
          </div>
        )}
        {editing && (
          <form action={action} className="flex max-w-sm flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="current" className="text-sm font-medium">
                Current password
              </label>
              <Input
                id="current"
                name="current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="next" className="text-sm font-medium">
                New password
              </label>
              <Input
                id="next"
                name="next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="confirm" className="text-sm font-medium">
                Repeat new password
              </label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <ul
              className="flex flex-col gap-1"
              aria-label="Password requirements"
            >
              <Rule ok={lengthOk}>
                {MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters
              </Rule>
              <Rule ok={differs}>Different from the current password</Rule>
              <Rule ok={matches}>Both new passwords match</Rule>
            </ul>
            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}
            <div className="flex gap-2">
              <SubmitButton
                disabled={!current || !lengthOk || !differs || !matches}
              >
                Change password
              </SubmitButton>
              <Button type="button" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
