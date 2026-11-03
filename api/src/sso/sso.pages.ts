const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/**
 * A small page for the sign-in flow: refused, or could not finish. Inline and script-free like the other pages the proxy
 * serves, and it says nothing about the app beyond what the visitor already knows.
 */
export function ssoPage(heading: string, message: string, retry?: string) {
  const link = retry
    ? `<p><a href="${esc(retry)}">Try another account</a></p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f8fb;color:#0b1220}
main{max-width:30rem;padding:2rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0;color:#475569}a{color:#0369a1}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e5edf7}p{color:#94a3b8}a{color:#38bdf8}}
</style></head><body><main><h1>${esc(heading)}</h1><p>${esc(message)}</p>${link}</main></body></html>`;
}
