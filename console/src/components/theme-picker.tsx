'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useTheme } from './theme-provider';

const OPTIONS: {
  value: Theme;
  label: string;
  hint: string;
  icon: typeof Sun;
}[] = [
  {
    value: 'system',
    label: 'System',
    hint: 'Follows your device, day and night',
    icon: Monitor,
  },
  { value: 'light', label: 'Light', hint: 'Always light', icon: Sun },
  { value: 'dark', label: 'Dark', hint: 'Always dark', icon: Moon },
];

/** The theme as a choice of three, for Settings. The header has the quick light/dark switch. */
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Remembered in this browser. The button in the top bar flips between
          light and dark; pick System here to follow your device again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {OPTIONS.map(({ value, label, hint, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => setTheme(value)}
              className={cn(
                'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring',
                theme === value && 'border-primary bg-secondary/40',
              )}
            >
              <Icon className="h-5 w-5" />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">
                  {hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
