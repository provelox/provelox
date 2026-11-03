import { MARK_SVG } from './mark';

export interface BrandPage {
  status: number;
  heading: string;
  message: string;
  hint?: string;
}

/**
 * The pages visitors see when an address has nothing to show. Brand colors come from the Provelox mark (cyan to blue),
 * on its dark navy and light tints; the page follows the visitor's light or dark setting. Everything is inline: the
 * proxy serves it when the app is down, so it cannot depend on anything else being up. Nothing about the app or the
 * server is shown.
 */
export const BRAND_PAGES = {
  '404': {
    status: 404,
    heading: 'Page not found',
    message: 'There is nothing at this address.',
    hint: 'Check the address for typos. If you expected an app here, it may be stopped or removed.',
  },
  '502': {
    status: 502,
    heading: 'Bad gateway',
    message: 'This app did not give a valid answer.',
    hint: 'It may be starting up or restarting. Try again in a moment.',
  },
  '503': {
    status: 503,
    heading: 'Service unavailable',
    message: 'This app is not running right now.',
    hint: 'It may be stopped, starting up, or being updated. Try again in a moment.',
  },
  '504': {
    status: 504,
    heading: 'Gateway timeout',
    message: 'This app took too long to answer.',
    hint: 'It may be busy. Try again in a moment.',
  },
} as const satisfies Record<string, BrandPage>;

export type BrandPageCode = keyof typeof BRAND_PAGES;

const CSS = `:root{--bg:#f4f8ff;--card:#fff;--text:#101827;--muted:#51607a;--line:#dfe9fb;--a:#14c9f1;--b:#2774fb}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#101827;--text:#e8eefc;--muted:#97a6c3;--line:#1d2a44}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:radial-gradient(60rem 30rem at 50% -10%,color-mix(in srgb,var(--b) 18%,transparent),transparent),var(--bg);color:var(--text);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:30rem;padding:2.5rem 2rem;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:1rem;box-shadow:0 1px 2px rgba(16,24,39,.05),0 12px 32px -12px rgba(39,116,251,.25)}
.mark{height:3rem;width:auto;margin:0 auto 1.25rem;display:block}
.code{margin:0;font-size:3.5rem;font-weight:800;line-height:1;letter-spacing:-.03em;background:linear-gradient(90deg,var(--a),var(--b));-webkit-background-clip:text;background-clip:text;color:transparent}
h1{margin:.75rem 0 .5rem;font-size:1.25rem}
p{margin:0}.msg{color:var(--text)}.hint{margin-top:.5rem;color:var(--muted);font-size:.9rem}

.tag{display:inline-block;margin:0;padding:.3rem .8rem;border-radius:999px;font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff;background:linear-gradient(90deg,var(--a),var(--b))}
footer{margin-top:1.75rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem}
footer b{font-weight:700;color:var(--text)}footer b i{font-style:normal;color:var(--b)}`;

function render(o: {
  title: string;
  lead: string;
  heading: string;
  message: string;
  hint?: string;
}): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<meta name="color-scheme" content="light dark"><title>${o.title}</title>` +
    `<style>${CSS}</style></head><body><main>${MARK_SVG}${o.lead}<h1>${o.heading}</h1>` +
    `<p class="msg">${o.message}</p>${o.hint ? `<p class="hint">${o.hint}</p>` : ''}` +
    `<footer>Served by <b>Provelo<i>x</i></b></footer></main></body></html>`
  );
}

export function brandPage(code: BrandPageCode): string {
  const p: BrandPage = BRAND_PAGES[code];
  return render({
    title: `${p.status} ${p.heading}`,
    lead: `<p class="code">${p.status}</p>`,
    heading: p.heading,
    message: p.message,
    hint: p.hint,
  });
}

/** What an app shows after it is created and before its first deploy. */
export function placeholderPage(): string {
  return render({
    title: 'Ready for its first deploy',
    lead: '<p class="tag">New app</p>',
    heading: 'This app is ready for its first deploy',
    message: 'Nothing has been deployed to it yet.',
    hint: 'Deploy an image from the console or from CI to replace this page.',
  });
}
