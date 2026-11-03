/** The title of a settings page and one sentence on what it is for. */
export function SettingsHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  /** An action for the right (a button) */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </div>
  );
}
