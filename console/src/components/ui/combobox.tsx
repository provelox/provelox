'use client';

import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import * as React from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** A second, quieter line (a role, a count) */
  description?: string;
  /** More words that should find it when searching */
  keywords?: string[];
  icon?: React.ReactNode;
  disabled?: boolean;
}

/** More options than this and a search box is shown, unless `searchable` says otherwise. */
const SEARCH_FROM = 6;

/**
 * A select you can type into: click, type a few letters, Enter. Replaces the native-looking select everywhere. Short
 * lists (a sort order, a unit) skip the search box and read as a plain menu; long ones (apps, servers, groups) search.
 * Give it `name` and it also submits with a plain `<form>`, like a select does.
 */
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing found.',
  searchable,
  size = 'default',
  className,
  contentClassName,
  id,
  name,
  required,
  disabled,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  searchable?: boolean;
  size?: 'sm' | 'default';
  className?: string;
  contentClassName?: string;
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  // uncontrolled use (a form that only reads `name`)
  const [inner, setInner] = React.useState(value ?? '');
  const current = value ?? inner;
  const selected = options.find((o) => o.value === current);
  const showSearch = searchable ?? options.length >= SEARCH_FROM;
  // The row the keyboard is on. It starts on what is chosen, not on the first row, so the highlight and the check agree.
  const [active, setActive] = React.useState(current);
  React.useEffect(() => {
    if (open) setActive(current);
  }, [open, current]);

  const choose = (v: string) => {
    setInner(v);
    onValueChange?.(v);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          data-placeholder={selected ? undefined : ''}
          data-size={size}
          className={cn(
            'flex w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 coarse:data-[size=default]:h-11 coarse:data-[size=sm]:h-10 dark:bg-input/30 dark:hover:bg-input/50',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected?.icon}
            <span className="truncate">{selected?.label ?? placeholder}</span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          'w-(--radix-popover-trigger-width) min-w-44',
          contentClassName,
        )}
      >
        <Command value={active} onValueChange={setActive}>
          {showSearch && <CommandInput placeholder={searchPlaceholder} />}
          <CommandList className="max-h-72">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  disabled={o.disabled}
                  onSelect={() => choose(o.value)}
                  className={cn(o.value === current && 'font-medium')}
                >
                  {o.icon}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.description && (
                      <span className="truncate text-xs text-muted-foreground">
                        {o.description}
                      </span>
                    )}
                  </span>
                  <CheckIcon
                    className={cn(
                      'size-4',
                      o.value === current ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
      {name && (
        <input
          type="text"
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          value={current}
          required={required}
          onChange={() => undefined}
          className="pointer-events-none absolute h-0 w-0 opacity-0"
        />
      )}
    </Popover>
  );
}
