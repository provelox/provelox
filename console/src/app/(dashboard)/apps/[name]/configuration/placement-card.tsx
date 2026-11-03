'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { releasePinAction } from '@/actions/apps';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import type { ClusterNode } from '@/lib/backend';
import { useUpdateApp } from '../use-update-app';

type Choice = 'any' | 'worker' | 'manager' | 'node';

const choiceOf = (p?: {
  node?: string;
  role?: 'worker' | 'manager';
}): Choice => (p?.node ? 'node' : (p?.role ?? 'any'));

/** Where in a cluster the app may run: anywhere, only workers or managers, or one named server. */
export function PlacementCard({
  appName,
  placement,
  pinnedTo,
  nodes,
}: {
  appName: string;
  placement?: { node?: string; role?: 'worker' | 'manager' };
  /** The server its data is on, which holds it there */
  pinnedTo: string | null;
  nodes: Pick<ClusterNode, 'id' | 'hostname' | 'role' | 'state'>[];
}) {
  const { update, pending } = useUpdateApp(appName);
  const [releasing, setReleasing] = useState(false);
  const [choice, setChoice] = useState<Choice>(choiceOf(placement));
  const [node, setNode] = useState(placement?.node ?? nodes[0]?.hostname ?? '');
  const saved = choiceOf(placement);
  const dirty =
    choice !== saved || (choice === 'node' && node !== (placement?.node ?? ''));
  const single = nodes.length < 2;

  const options: { id: Choice; title: string; hint: string }[] = [
    { id: 'any', title: 'Any server', hint: 'Swarm picks the one with room.' },
    {
      id: 'worker',
      title: 'Workers only',
      hint: 'Keeps it off the managers that run the platform.',
    },
    { id: 'manager', title: 'Managers only', hint: 'Only on a manager.' },
    {
      id: 'node',
      title: 'One server',
      hint: 'Always on the server you choose.',
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where it runs</CardTitle>
        <CardDescription>
          Choose which servers of your cluster may run this app.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {pinnedTo ? (
          <p className="rounded-md border p-3 text-sm">
            This app keeps its data on <strong>{pinnedTo}</strong>, so it always
            runs there. Moving it would leave the data behind. To run it
            elsewhere, move the data first (see Storage). If {pinnedTo} is gone
            or being replaced, you can release it: Provelox then forgets where
            the data is (it is not moved) and you choose the app&apos;s server
            again.
            <span className="mt-2 block">
              <Button
                variant="outline"
                size="sm"
                disabled={pending || releasing}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Release ${appName} from ${pinnedTo}? The data stays on ${pinnedTo}; Provelox just stops holding the app there.`,
                    )
                  )
                    return;
                  setReleasing(true);
                  const r = await releasePinAction(appName);
                  setReleasing(false);
                  if (r.ok) toast.success('Released');
                  else toast.error(r.error);
                }}
              >
                Release from {pinnedTo}…
              </Button>
            </span>
          </p>
        ) : single ? (
          <p className="text-sm text-muted-foreground">
            This is the only server, so there is nothing to choose between. Add
            more under{' '}
            <Link href="/settings/infrastructure" className="underline">
              Settings → Infrastructure
            </Link>
            .
          </p>
        ) : (
          <>
            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <legend className="sr-only">Where the app may run</legend>
              {options.map((o) => (
                <label
                  key={o.id}
                  className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${choice === o.id ? 'border-primary bg-primary/5' : ''}`}
                >
                  <input
                    type="radio"
                    name="placement"
                    className="mt-1 accent-primary"
                    checked={choice === o.id}
                    onChange={() => setChoice(o.id)}
                  />
                  <span>
                    <span className="block font-medium">{o.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {o.hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {choice === 'node' && (
              <div className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
                Server
                <Combobox
                  value={node}
                  onValueChange={setNode}
                  aria-label="Server"
                  className="w-full"
                  options={nodes.map((n) => ({
                    value: n.hostname,
                    label: n.hostname,
                    description: `${n.role === 'worker' ? 'worker' : 'manager'}${n.state !== 'ready' ? `, ${n.state}` : ''}`,
                  }))}
                />
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button
                disabled={pending || !dirty || (choice === 'node' && !node)}
                onClick={() =>
                  update(
                    {
                      placement:
                        choice === 'any'
                          ? null
                          : choice === 'node'
                            ? { node }
                            : { role: choice },
                    },
                    'Saved. The app moves to a matching server.',
                  )
                }
              >
                Save
              </Button>
              {dirty && (
                <span className="text-xs text-muted-foreground">
                  The app restarts on a server that matches.
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
