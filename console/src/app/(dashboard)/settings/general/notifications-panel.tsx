'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  addWebhookAction,
  removeWebhookAction,
  setNotificationEventsAction,
  testWebhookAction,
} from '@/actions/system';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { Notifications } from '@/lib/backend';
import { timeAgo } from '@/lib/format';

const EVENTS = [
  {
    key: 'problem',
    title: 'An app is failing',
    hint: 'It keeps failing to start, or runs with a failing health check. Sent once it has lasted a minute, not for a restart.',
  },
  {
    key: 'recovered',
    title: 'An app is back',
    hint: 'One that was reported is running normally again.',
  },
  {
    key: 'certificate',
    title: 'A certificate is running out',
    hint: 'It is about to expire, or has, without renewing.',
  },
] as const;

/** Where Provelox sends word when something needs you: webhooks that Slack, Discord and most chat tools accept. */
export function NotificationsPanel({ initial }: { initial: Notifications }) {
  const [pending, startTransition] = useTransition();
  const [working, setWorking] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState(initial.events);

  function run(
    key: string,
    work: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    after?: () => void,
  ) {
    setWorking(key);
    startTransition(async () => {
      const res = await work();
      if (res.ok) {
        toast.success(success);
        after?.();
      } else toast.error(res.error ?? 'Request failed');
      setWorking(null);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Get told when something needs you. Add a webhook (an incoming webhook
          from Slack or Discord, or any address that accepts a JSON post) and
          choose what it hears about.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="divide-y rounded-md border">
          {EVENTS.map((e) => (
            <div
              key={e.key}
              className="flex items-center justify-between gap-4 p-3"
            >
              <div>
                <p className="text-sm font-medium">{e.title}</p>
                <p className="text-xs text-muted-foreground">{e.hint}</p>
              </div>
              <Switch
                checked={events[e.key]}
                disabled={pending}
                aria-label={e.title}
                onCheckedChange={(on) => {
                  setEvents((cur) => ({ ...cur, [e.key]: on }));
                  run(
                    `ev:${e.key}`,
                    () => setNotificationEventsAction({ [e.key]: on }),
                    'Saved',
                  );
                }}
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Webhooks</h4>
          {initial.webhooks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet. Nothing is sent until you add one.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {initial.webhooks.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{w.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {w.host}
                    </p>
                    {w.lastStatus && (
                      <p className="text-xs text-muted-foreground">
                        Last: {w.lastStatus}
                        {w.lastAt && `, ${timeAgo(w.lastAt)}`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setWorking(`test:${w.id}`);
                        startTransition(async () => {
                          const res = await testWebhookAction(w.id);
                          if (!res.ok) toast.error(res.error);
                          else if (res.data?.ok) toast.success(res.data.status);
                          else
                            toast.error(
                              res.data?.status ?? 'It did not arrive',
                            );
                          setWorking(null);
                        });
                      }}
                    >
                      {working === `test:${w.id}` && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      Send a test
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Remove ${w.name}`}
                      onClick={() =>
                        run(
                          `rm:${w.id}`,
                          () => removeWebhookAction(w.id),
                          `Removed ${w.name}`,
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[12rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                'add',
                () => addWebhookAction(name, url),
                `Added ${name.trim()}`,
                () => {
                  setName('');
                  setUrl('');
                },
              );
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, like Team chat"
              aria-label="Webhook name"
            />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              aria-label="Webhook address"
              className="font-mono"
              autoComplete="off"
            />
            <Button
              type="submit"
              disabled={pending || !name.trim() || !url.trim()}
            >
              {working === 'add' && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Add webhook
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            The address usually contains a secret, so it is saved sealed and
            only its host is shown again.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
