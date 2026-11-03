'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  explainGroupName,
  MAX_GROUP_NAME,
  type GroupsFile,
} from '@/lib/groups';

/** Asks for a group name (new or renamed) and validates it against the existing groups as you type. */
export function GroupNameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName = '',
  confirmLabel,
  groups,
  exceptId,
  pending,
  serverError,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initialName?: string;
  confirmLabel: string;
  groups: GroupsFile;
  exceptId?: string;
  pending: boolean;
  serverError?: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setTouched(false);
    }
  }, [open, initialName]);

  const problem = explainGroupName(name, groups, exceptId);
  const shown = serverError || (touched ? problem : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!problem) onSubmit(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription>{description}</DialogDescription>
            )}
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Input
              autoFocus
              value={name}
              maxLength={MAX_GROUP_NAME + 10}
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
              }}
              placeholder="e.g. Online shop"
              aria-label="Collection name"
              aria-invalid={!!shown}
            />
            {shown && (
              <p role="alert" className="text-xs text-destructive">
                {shown}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !!problem}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
