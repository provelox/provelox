import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the code editor theme', () => {
  const source = readFileSync('src/components/code-editor.tsx', 'utf8');

  it('uses the console colours, not the raw numbers behind them', () => {
    // --background, --border and the like hold colour components ("0 0% 100%"), not colours: as a background or a
    // border they are invalid, and the property silently falls back to transparent. That left the line numbers with no
    // background, so text scrolled sideways showed through them. The colours are --color-background and so on.
    expect(source).not.toMatch(
      /var\(--(background|foreground|muted-foreground|border|input|ring)\)/,
    );
  });

  it('gives the line numbers a solid background, since the text passes under them', () => {
    expect(source).toMatch(
      /'\.cm-gutters':\s*\{[^}]*backgroundColor:\s*'var\(--color-background\)'/,
    );
  });
});
