'use client';

import { Logo } from '@/components/brand/logo';
import { useActionState } from 'react';
import { loginAction, type LoginState } from '@/actions/auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <Logo className="mb-2 [&>span:last-child]:text-xl" />
        <CardTitle className="text-lg">Deploy faster. Scale smarter.</CardTitle>
        <CardDescription>Sign in to continue</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-3">
          {next && <input type="hidden" name="next" value={next} />}
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <SubmitButton>Sign in</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
