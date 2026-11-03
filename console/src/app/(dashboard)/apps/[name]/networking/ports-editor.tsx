'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import type { AppDefinition } from '@/lib/types';
import { useUpdateApp } from '../use-update-app';

type Port = AppDefinition['ports'][number];

// Used by Docker Swarm itself, or by the proxy in front of every app (80/443)
const RESERVED = new Set([80, 443, 2377, 4789, 7946]);

const issue = (rows: Port[]): string | null => {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!Number.isInteger(r.hostPort) || r.hostPort < 1 || r.hostPort > 65535)
      return 'Host ports must be between 1 and 65535';
    if (
      !Number.isInteger(r.containerPort) ||
      r.containerPort < 1 ||
      r.containerPort > 65535
    )
      return 'Container ports must be between 1 and 65535';
    if (RESERVED.has(r.hostPort))
      return `Host port ${r.hostPort} is used by the proxy or Docker itself`;
    const key = `${r.hostPort}/${r.protocol ?? 'tcp'}`;
    if (seen.has(key)) return `Host port ${r.hostPort} is listed twice`;
    seen.add(key);
  }
  return null;
};

export function PortsEditor({
  appName,
  initial,
  pendingPorts = [],
}: {
  appName: string;
  initial: Port[];
  /** Mappings waiting for another platform to release the host port (an imported CapRover app) */
  pendingPorts?: Port[];
}) {
  const { update, pending } = useUpdateApp(appName);
  const [rows, setRows] = useState<Port[]>(initial);

  const problem = issue(rows);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);
  const set = (i: number, patch: Partial<Port>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const num = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Port forwarding</CardTitle>
        <CardDescription>
          Publish a port of this app directly on the server (for TCP/UDP
          services such as databases, game servers or SSH). Web traffic
          doesn&apos;t need this, it already goes through the proxy. Remember to
          open the host port in your firewall.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No ports published.</p>
        )}
        {pendingPorts.length > 0 && (
          <div className="rounded-md border border-dashed p-3 text-sm">
            <p className="font-medium">Waiting for cutover</p>
            <p className="text-muted-foreground">
              CapRover still publishes these host ports, and Docker allows only
              one service per port. They are published when this app takes over
              from CapRover.
            </p>
            <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
              {pendingPorts.map((p) => (
                <li key={`${p.hostPort}/${p.protocol ?? 'tcp'}`}>
                  {p.hostPort} → {p.containerPort}/{p.protocol ?? 'tcp'}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={65535}
              value={r.hostPort || ''}
              onChange={(e) => set(i, { hostPort: num(e.target.value) })}
              placeholder="Host port"
              className="w-32"
              aria-label={`Mapping ${i + 1} host port`}
            />
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
            <Input
              type="number"
              min={1}
              max={65535}
              value={r.containerPort || ''}
              onChange={(e) => set(i, { containerPort: num(e.target.value) })}
              placeholder="Container port"
              className="w-36"
              aria-label={`Mapping ${i + 1} container port`}
            />
            <Combobox
              value={r.protocol ?? 'tcp'}
              onValueChange={(v) => set(i, { protocol: v as 'tcp' | 'udp' })}
              className="w-24"
              aria-label={`Mapping ${i + 1} protocol`}
              options={[
                { value: 'tcp', label: 'TCP' },
                { value: 'udp', label: 'UDP' },
              ]}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove mapping"
              onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {problem && rows.length > 0 && (
          <p className="text-xs text-destructive">{problem}</p>
        )}
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                { hostPort: 0, containerPort: 0, protocol: 'tcp' },
              ])
            }
          >
            <Plus className="h-4 w-4" /> Add mapping
          </Button>
          <Button
            size="sm"
            disabled={pending || !!problem || !dirty}
            onClick={() => update({ ports: rows }, 'Ports saved')}
          >
            Save changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
