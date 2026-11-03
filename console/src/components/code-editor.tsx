'use client';

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from '@codemirror/view';
import { linter } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { parseDocument } from 'yaml';
import { useEffect, useRef } from 'react';

// Colours come from CSS variables, so light and dark follow the console's theme without a second editor theme.
const theme = EditorView.theme({
  '&': {
    fontSize: '12px',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    borderRadius: '6px',
    border: '1px solid var(--input)',
  },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '1px' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    minHeight: '16rem',
    maxHeight: '24rem',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--foreground)', padding: '8px 0' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    border: 'none',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--ring) 30%, transparent)',
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
});

// light-dark() follows the page's color-scheme, which the .dark class sets.
const c = {
  key: 'light-dark(#0369a1, #7dd3fc)',
  string: 'light-dark(#15803d, #86efac)',
  value: 'light-dark(#b45309, #fcd34d)',
  punct: 'light-dark(#6b7280, #9ca3af)',
  anchor: 'light-dark(#7e22ce, #d8b4fe)',
  variable: 'light-dark(#be185d, #f9a8d4)',
};

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: c.key, fontWeight: '500' },
  { tag: t.string, color: c.string },
  { tag: t.content, color: c.value },
  { tag: [t.number, t.bool, t.null], color: c.value },
  { tag: [t.comment, t.lineComment], color: c.punct, fontStyle: 'italic' },
  { tag: [t.separator, t.squareBracket, t.brace], color: c.punct },
  { tag: [t.labelName, t.typeName, t.meta, t.keyword], color: c.anchor },
]);

// ${VARIABLE} stands out from the text around it, since these are the values the form below fills in.
const variableMark = Decoration.mark({
  attributes: { style: `color:${c.variable};font-weight:600` },
});
const variables = new MatchDecorator({
  regexp: /\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g,
  decoration: () => variableMark,
});
const variableHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = variables.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = variables.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** A YAML mistake, shown under the line it is on as the person types. */
const yamlLint = linter(
  (view) => {
    const doc = parseDocument(view.state.doc.toString());
    return [...doc.errors, ...doc.warnings].map((e) => ({
      from: e.pos[0],
      to: Math.max(e.pos[1], e.pos[0] + 1),
      severity: doc.errors.includes(e) ? 'error' : 'warning',
      message: e.message.split('\n')[0],
    }));
  },
  { delay: 400 },
);

/** Rewrites the text with consistent two-space indentation. Comments are kept; the YAML is not changed in meaning. */
export function formatYaml(text: string): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  return doc.toString({ indent: 2, lineWidth: 0 });
}

/** A small YAML editor: Tab indents, Shift-Tab outdents, Enter keeps the indentation, and Escape lets Tab move focus on. */
export function CodeEditor({
  id,
  value,
  onChange,
  placeholder,
  fill,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Take all the height the parent gives, instead of growing to a limit */
  fill?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          indentOnInput(),
          bracketMatching(),
          yaml(),
          syntaxHighlighting(highlight),
          variableHighlight,
          yamlLint,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorState.tabSize.of(2),
          placeholderExt(placeholder ?? ''),
          theme,
          EditorView.contentAttributes.of({
            ...(id ? { id } : {}),
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; later changes to `value` are applied below.
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={host}
      className={
        fill
          ? 'overflow-hidden lg:min-h-64 lg:flex-1 lg:[&_.cm-editor]:h-full lg:[&_.cm-scroller]:!max-h-none'
          : undefined
      }
    />
  );
}
