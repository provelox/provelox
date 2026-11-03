import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-2">
      <h2 className="text-lg font-semibold">Not found</h2>
      <p className="text-sm text-muted-foreground">
        That app or page does not exist.
      </p>
      <Link href="/apps" className="text-sm underline">
        Back to apps
      </Link>
    </div>
  );
}
