'use client';

import {
  AlertTriangle,
  Check,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  loadClusterAction,
  loadJoinAction,
  removeNodeAction,
  rotateJoinTokenAction,
  setNodeAvailabilityAction,
  setNodeRoleAction,
} from '@/actions/cluster';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { checkAdvertise, checkManager, joinCommands } from '@/lib/join-command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {
  ClusterNode,
  ClusterOverview,
  JoinInstructions,
} from '@/lib/backend';
import { formatBytes, formatMachineRam } from '@/lib/format';

const ROLE = {
  leader: 'Leader (main node)',
  manager: 'Manager',
  worker: 'Worker',
} as const;

type Change = {
  kind: 'drain' | 'pause' | 'active' | 'promote' | 'demote' | 'remove';
  node: ClusterNode;
};

const workloadText = (n: ClusterNode) =>
  n.workloads.map((w) => (w.count > 1 ? `${w.name} ×${w.count}` : w.name));

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{value || '—'}</dd>
    </div>
  );
}

/** What a change will do, in words, before it is made. */
function explain(c: Change): {
  title: string;
  body: React.ReactNode;
  action: string;
  destructive?: boolean;
} {
  const name = c.node.hostname || c.node.id;
  const apps = c.node.workloads.filter((w) => w.kind === 'app');
  const held = apps.filter((a) => a.pinned).map((a) => a.name);
  const moved =
    apps.length > 0 ? (
      <>
        These run there now and will start again on other servers:{' '}
        <strong>
          {apps
            .filter((a) => !a.pinned)
            .map((a) => a.name)
            .join(', ') || 'none'}
        </strong>
        .{' '}
        {apps.some((a) => a.pinned) && (
          <>
            <strong>
              {apps
                .filter((a) => a.pinned)
                .map((a) => a.name)
                .join(', ')}
            </strong>{' '}
            keep their data on {name} and cannot run anywhere else, so they stay
            stopped until {name} takes work again.
          </>
        )}
      </>
    ) : (
      'Nothing of yours runs there now.'
    );
  switch (c.kind) {
    case 'drain':
      return {
        title: `Drain ${name}?`,
        body: (
          <>
            Its work is moved to other servers and it takes none until you
            activate it again. Good before maintenance. {moved}
          </>
        ),
        action: 'Drain',
      };
    case 'pause':
      return {
        title: `Pause ${name}?`,
        body: 'It keeps what it runs but takes no new work, such as new apps or more instances.',
        action: 'Pause',
      };
    case 'active':
      return {
        title: `Let ${name} take work again?`,
        body: 'New apps and instances can run there again. Work already moved away does not come back by itself.',
        action: 'Activate',
      };
    case 'promote':
      return {
        title: `Make ${name} a manager?`,
        body: 'A manager can run the platform’s own services and decide for the cluster. Keep an odd number of managers (1, 3 or 5): two are no safer than one.',
        action: 'Promote',
      };
    case 'demote':
      return {
        title: `Make ${name} a worker?`,
        body: 'It stops being a manager and only runs apps. The cluster needs at least one manager at all times.',
        action: 'Demote',
      };
    case 'remove':
      return {
        title: `Remove ${name} from the cluster?`,
        body: (
          <>
            It is no longer part of the cluster and gets none of its work.{' '}
            {moved}{' '}
            {held.length > 0 && (
              <>
                <strong>{held.join(', ')}</strong> keep their data on {name}:
                release them first (Configuration → Where it runs), or the data
                is left behind.{' '}
              </>
            )}
            Docker only removes a server that has left the cluster: run{' '}
            <code>docker swarm leave</code> on it first, and when it shows as
            down, remove it here.
          </>
        ),
        action: 'Remove',
        destructive: true,
      };
  }
}

function JoinDialog({
  open,
  onOpenChange,
  managers,
  knownIds,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  managers: number;
  /** The machines already in the cluster, so a new one can be told apart */
  knownIds: string[];
}) {
  const router = useRouter();
  const [info, setInfo] = useState<JoinInstructions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<'worker' | 'manager'>('worker');
  const [manager, setManager] = useState('');
  const [advertise, setAdvertise] = useState('');
  const [pending, start] = useTransition();
  const [rotating, setRotating] = useState(false);
  const [joined, setJoined] = useState<ClusterNode | null>(null);
  const [waited, setWaited] = useState(0);

  // Asked for when the dialog opens, never with the page: the tokens are secrets
  useEffect(() => {
    if (!open || info) return;
    start(async () => {
      const r = await loadJoinAction();
      if (r.ok && r.data) {
        setInfo(r.data);
        setManager((m) => m || r.data!.managerAddress);
      } else if (!r.ok) setError(r.error);
    });
  }, [open, info]);

  // Once the commands are on screen, look every few seconds for a machine that was not there before
  useEffect(() => {
    if (!open || !info || joined) return;
    const known = new Set(knownIds);
    const started = Date.now();
    const id = setInterval(async () => {
      setWaited(Math.round((Date.now() - started) / 1000));
      const r = await loadClusterAction();
      const fresh = r.ok
        ? r.data?.nodes.find((n) => !known.has(n.id))
        : undefined;
      if (fresh) {
        setJoined(fresh);
        toast.success(`${fresh.hostname || fresh.id} joined the cluster`);
        router.refresh();
      }
    }, 4000);
    return () => clearInterval(id);
  }, [open, info, joined, knownIds, router]);

  const opened = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setJoined(null);
      setWaited(0);
    }
  };

  const mgr = checkManager(manager);
  const adv = checkAdvertise(advertise);
  const shown = info?.[role];
  const cmds =
    info && shown && mgr.ok && adv.ok
      ? joinCommands(shown.token, info.image, mgr.address, adv.value)
      : null;
  const portsText = info?.ports.join(', ');

  return (
    <Dialog open={open} onOpenChange={opened}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Run one command on the new server. It needs Docker, and it must be
            able to reach this one on the ports below. No password or key is
            shared with Provelox.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {pending && !info && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Getting the join
            details…
          </p>
        )}
        {info && shown && (
          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
            <div className="inline-flex w-fit rounded-md border p-0.5 text-sm">
              {(['worker', 'manager'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                  className={`rounded px-3 py-1 ${role === r ? 'bg-secondary font-medium' : 'text-muted-foreground'}`}
                >
                  Join as {r === 'worker' ? 'a worker' : 'a manager'}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {role === 'worker'
                ? 'A worker runs apps. This is what most servers should be.'
                : `A manager also holds the cluster's state and can run the platform's own services. You have ${managers}; keep an odd number (1, 3 or 5).`}
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                This server&apos;s address, as the new one reaches it
                <Input
                  value={manager}
                  onChange={(e) => setManager(e.target.value)}
                  className="font-mono"
                  aria-invalid={!mgr.ok}
                  placeholder="203.0.113.10"
                />
                <span className="text-xs font-normal text-muted-foreground">
                  Use a private address if the servers share a network, a public
                  one if not. Port {info.managerAddress.split(':').pop()} is
                  added for you.
                </span>
                {!mgr.ok && (
                  <span
                    role="alert"
                    className="text-xs font-normal text-destructive"
                  >
                    {mgr.error}
                  </span>
                )}
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                New server&apos;s own address (optional)
                <Input
                  value={advertise}
                  onChange={(e) => setAdvertise(e.target.value)}
                  className="font-mono"
                  aria-invalid={!adv.ok}
                  placeholder="203.0.113.20"
                />
                <span className="text-xs font-normal text-muted-foreground">
                  Fill this in when the new server has more than one address, so
                  the others know which to use.
                </span>
                {!adv.ok && (
                  <span
                    role="alert"
                    className="text-xs font-normal text-destructive"
                  >
                    {adv.error}
                  </span>
                )}
              </label>
            </div>

            {cmds && (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      On the new server, run:
                    </p>
                    <CopyButton value={cmds.provelox} />
                  </div>
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                    {cmds.provelox}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    It checks that the new server can reach{' '}
                    {mgr.ok && mgr.address} before it joins, and says which
                    ports to open if it cannot.
                  </p>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    Or with Docker directly
                  </summary>
                  <div className="mt-2 flex flex-col gap-1.5">
                    <div className="flex justify-end">
                      <CopyButton value={cmds.swarm} />
                    </div>
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                      {cmds.swarm}
                    </pre>
                  </div>
                </details>
              </>
            )}

            <div className="flex flex-col gap-1 rounded-md border p-3 text-xs text-muted-foreground">
              <p>
                <strong className="text-foreground">Firewall.</strong> Between
                the servers, and only between them, open {portsText}, plus IP
                protocol 50 (ESP) because the cluster network is encrypted. Do
                not open these to the internet. The new server also pulls your
                apps&apos; images itself, so it must reach their registries.
              </p>
              <p>
                Anyone with this token who can reach port 2377 can join a server
                to your cluster. Make a new token once the server has joined, or
                if it was shared too widely: the old one stops working.
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rotating}
                  onClick={async () => {
                    setRotating(true);
                    const r = await rotateJoinTokenAction(role);
                    setRotating(false);
                    if (r.ok && r.data) {
                      setInfo(r.data);
                      toast.success(`New ${role} token made`);
                    } else if (!r.ok) toast.error(r.error);
                  }}
                >
                  {rotating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Make a new {role} token
                </Button>
              </div>
            </div>

            <div
              role="status"
              className={`rounded-md border p-3 text-sm ${joined ? 'border-emerald-500/40 bg-emerald-500/10' : ''}`}
            >
              {joined ? (
                <p className="flex items-center gap-2">
                  <Check
                    className="h-4 w-4 text-emerald-600"
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{joined.hostname || joined.id}</strong> joined as a{' '}
                    {joined.role === 'worker' ? 'worker' : 'manager'}. Make a
                    new token now if the old one should not be used again.
                  </span>
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    Waiting for the new server to join…
                  </p>
                  {waited >= 60 && (
                    <ul className="ml-6 list-disc text-xs text-muted-foreground">
                      <li>
                        Did the command print an error? It names the port or
                        address it could not reach.
                      </li>
                      <li>
                        Are {portsText} and ESP open between the two servers, in
                        both directions?
                      </li>
                      <li>
                        Does the new server have more than one address? Fill in
                        its own address above.
                      </li>
                      <li>
                        Is Docker running on it, and not already in another
                        Swarm?
                      </li>
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => opened(false)}>
            {joined ? 'Done' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The machines of the cluster: what each is and runs, how to add one, and how to take one out of service. */
export function ClusterCard({
  cluster,
}: {
  cluster: ClusterOverview & { managed: boolean };
}) {
  const [data, setData] = useState(cluster);
  const [change, setChange] = useState<Change | null>(null);
  const [joining, setJoining] = useState(false);
  const [pending, start] = useTransition();
  const [seen, setSeen] = useState(cluster);
  // Show what the page loaded again after a refresh, but keep what a change just returned until then
  if (seen !== cluster) {
    setSeen(cluster);
    setData(cluster);
  }

  function run(c: Change) {
    start(async () => {
      const id = c.node.id;
      const r =
        c.kind === 'promote'
          ? await setNodeRoleAction(id, 'manager')
          : c.kind === 'demote'
            ? await setNodeRoleAction(id, 'worker')
            : c.kind === 'remove'
              ? await removeNodeAction(id)
              : await setNodeAvailabilityAction(id, c.kind);
      if (r.ok) {
        if (r.data) setData({ ...r.data, managed: true });
        toast.success('Done');
        setChange(null);
      } else toast.error(r.error);
    });
  }

  const nodes = data.nodes;
  return (
    <Card>
      <CardHeader className="flex-col sm:flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Servers</CardTitle>
          <CardDescription>
            The machines your apps run on, as Docker reports them
            {data.managed
              ? '. Add more to spread apps across them.'
              : '. This API cannot manage them yet: update Provelox to add or change servers here.'}
          </CardDescription>
        </div>
        {data.managed && data.canJoin && (
          <Button size="sm" onClick={() => setJoining(true)}>
            <Plus className="h-4 w-4" /> Add a server
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {data.encryptCommand && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                aria-hidden="true"
              />
              Traffic between your servers is not encrypted. That is fine on a
              private network or a VPN, but not across the internet.
            </p>
            <div className="ml-6 flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                To fix it, run this on a manager at a quiet moment. Apps restart
                one at a time and are unreachable for a moment, and so are the
                console and API for a few seconds.
              </p>
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted p-2 text-xs">
                  {data.encryptCommand}
                </pre>
                <CopyButton value={data.encryptCommand} />
              </div>
            </div>
          </div>
        )}
        {data.warnings.length > 0 && (
          <ul className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {data.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                {w}
              </li>
            ))}
          </ul>
        )}
        {nodes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            This Docker host is not part of a Swarm, so there is nothing to
            list.
          </p>
        )}
        {nodes.map((n) => {
          const isManager = n.role !== 'worker';
          return (
            <div key={n.id} className="rounded-md border p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-medium">
                  {n.hostname || n.id}
                  {n.isLocal && (
                    <Badge title="The machine the API runs on and talks to">
                      this server
                    </Badge>
                  )}
                </p>
                <span className="flex items-center gap-2">
                  <Badge
                    variant={n.state === 'ready' ? 'success' : 'destructive'}
                  >
                    {n.state}
                  </Badge>
                  <Badge
                    variant={
                      n.availability === 'active' ? 'default' : 'warning'
                    }
                    title={
                      n.availability === 'drain'
                        ? 'Its work has been moved away and it takes none'
                        : n.availability === 'pause'
                          ? 'It takes no new work'
                          : 'It takes work'
                    }
                  >
                    {n.availability}
                  </Badge>
                  {data.managed && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Manage ${n.hostname || n.id}`}
                          disabled={pending}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {n.availability !== 'active' && (
                          <DropdownMenuItem
                            onSelect={() =>
                              setChange({ kind: 'active', node: n })
                            }
                          >
                            Activate (take work again)
                          </DropdownMenuItem>
                        )}
                        {n.availability === 'active' && (
                          <DropdownMenuItem
                            onSelect={() =>
                              setChange({ kind: 'pause', node: n })
                            }
                          >
                            Pause (no new work)
                          </DropdownMenuItem>
                        )}
                        {n.availability !== 'drain' && (
                          <DropdownMenuItem
                            onSelect={() =>
                              setChange({ kind: 'drain', node: n })
                            }
                          >
                            Drain (move its work away)
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {isManager ? (
                          <DropdownMenuItem
                            disabled={n.isLocal}
                            onSelect={() =>
                              setChange({ kind: 'demote', node: n })
                            }
                          >
                            Make a worker{n.isLocal ? ' (not this server)' : ''}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled={n.state !== 'ready'}
                            onSelect={() =>
                              setChange({ kind: 'promote', node: n })
                            }
                          >
                            Make a manager
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={isManager || n.isLocal}
                          onSelect={() =>
                            setChange({ kind: 'remove', node: n })
                          }
                        >
                          Remove from cluster…
                          {isManager ? ' (make it a worker first)' : ''}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </span>
              </div>
              {data.managed && (
                <p className="mb-3 text-sm text-muted-foreground">
                  {n.workloads.length === 0
                    ? 'Nothing runs here.'
                    : `Runs: ${workloadText(n).join(', ')}`}
                </p>
              )}
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <Field label="Type" value={ROLE[n.role]} />
                <Field label="IP" value={n.address} />
                <Field label="RAM" value={formatMachineRam(n.memoryBytes)} />
                <Field
                  label="CPU"
                  value={`${n.cpus} core${n.cpus === 1 ? '' : 's'}`}
                />
                <Field label="Operating system" value={n.osName ?? n.os} />
                {n.kernel && <Field label="Kernel" value={n.kernel} />}
                <Field label="Architecture" value={n.architecture} />
                <Field label="Docker version" value={n.dockerVersion} />
                <Field label="Node ID" value={n.id} />
              </dl>
            </div>
          );
        })}
      </CardContent>

      <JoinDialog
        open={joining}
        onOpenChange={setJoining}
        managers={data.managers}
        knownIds={data.nodes.map((n) => n.id)}
      />

      {change && (
        <Dialog open onOpenChange={(o) => !o && !pending && setChange(null)}>
          <DialogContent>
            {(() => {
              const e = explain(change);
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>{e.title}</DialogTitle>
                    <DialogDescription asChild>
                      <div className="text-sm text-muted-foreground">
                        {e.body}
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setChange(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant={e.destructive ? 'destructive' : 'default'}
                      disabled={pending}
                      onClick={() => run(change)}
                    >
                      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                      {e.action}
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
