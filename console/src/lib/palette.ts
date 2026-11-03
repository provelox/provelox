import type { LucideIcon } from 'lucide-react';

/** `here` is what can be done to the page you are on (an app, a project, a group). */
export type Section = 'here' | 'pages' | 'apps' | 'actions';

export interface Entry {
  id: string;
  section: Section;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  keywords: string[];
  href?: string;
  /** The keyboard shortcut for it, shown beside it */
  hint?: string;
  run?: () => void | Promise<void>;
  /** only offered once something is typed (keeps the empty palette short) */
  searchOnly?: boolean;
  /** only offered when what is typed contains this word (an app's own sections, found by naming the app) */
  scope?: string;
}

const PREFIXES: Record<string, Section> = {
  '/': 'pages',
  '#': 'apps',
  '>': 'actions',
};
export function parse(query: string): { mode: Section | null; text: string } {
  const first = query.trimStart()[0];
  const mode = first ? PREFIXES[first] : undefined;
  return mode
    ? { mode, text: query.trimStart().slice(1).trim() }
    : { mode: null, text: query.trim() };
}

export function matches(entry: Entry, text: string) {
  if (!text) return true;
  if (entry.scope && !text.toLowerCase().includes(entry.scope.toLowerCase()))
    return false;
  const hay =
    `${entry.title} ${entry.subtitle ?? ''} ${entry.keywords.join(' ')}`.toLowerCase();
  return text
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}
