import { XCircle } from 'lucide-react';
import { explainDeployFailure } from '@/lib/deploy-failure';

/** A failed deploy: what went wrong, why, and what to do first, with Docker's own words kept as the detail. */
export function DeployFailure({ lines }: { lines: string[] }) {
  const f = explainDeployFailure(lines);
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        {f.title}
      </p>
      <p className="text-sm text-muted-foreground">{f.why}</p>
      {f.steps.length > 0 && (
        <div>
          <p className="text-sm font-medium">What to do</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {f.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      {lines.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Details from Docker
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono leading-relaxed whitespace-pre-wrap">
            {lines.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
