import { SectionNav, type SectionLink } from '@/components/section-nav';

/** A tab with several sections: the sections on the left, the "on this page" list on the right. */
export function SectionedPage({
  sections,
  aside = true,
  children,
}: {
  sections: SectionLink[];
  /** False where the page's sections are already listed elsewhere (an app's left rail) */
  aside?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        aside ? 'grid gap-8 lg:grid-cols-[minmax(0,1fr)_13rem]' : 'grid gap-8'
      }
    >
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      {aside && (
        <aside className="hidden lg:block">
          <SectionNav sections={sections} />
        </aside>
      )}
    </div>
  );
}
