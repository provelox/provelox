'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { revokeApiKeyAction } from '@/actions/api-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ApiKey } from '@/lib/types';

export function ApiKeyList({
  keys,
  title = 'Active keys',
  showApp = true,
}: {
  keys: ApiKey[];
  title?: string;
  /** Hidden where every key is for the same app */
  showApp?: boolean;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {keys.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">No keys yet.</p>
        )}
        {keys.map((k) => (
          <div
            key={k.id}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                {k.name} {showApp && <Badge>{k.appName}</Badge>}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                Created {new Date(k.createdAt).toLocaleDateString()} ·{' '}
                {k.lastUsedAt
                  ? `last used ${new Date(k.lastUsedAt).toLocaleString()}${k.lastUsedImage ? ` (${k.lastUsedImage})` : ''}`
                  : 'never used'}
              </p>
            </div>
            {confirmId === k.id ? (
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await revokeApiKeyAction(k.id);
                      if (res.ok) toast.success('Key revoked');
                      else toast.error(res.error);
                      setConfirmId(null);
                    })
                  }
                >
                  Revoke now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmId(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmId(k.id)}
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
