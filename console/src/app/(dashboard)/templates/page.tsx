import { cookies } from 'next/headers';
import {
  loadProjects,
  loadTemplateSources,
  loadTemplates,
} from '@/lib/backend';
import { withSession } from '@/lib/with-session';
import { TEMPLATES_VIEW_COOKIE } from '@/lib/templates-view';
import { TemplatesBrowser } from './templates-browser';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const [templates, projects, sources] = await Promise.all([
    withSession(loadTemplates),
    withSession(loadProjects),
    withSession(loadTemplateSources),
  ]);
  // read here, not after the page loads, so a grid view is drawn as a grid from the first paint
  const view =
    (await cookies()).get(TEMPLATES_VIEW_COOKIE)?.value === 'grid'
      ? 'grid'
      : 'list';
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Templates</h1>
        <p className="text-sm text-muted-foreground">
          Ready-made apps. Pick one, fill in a few values, and it is running in
          a minute.
        </p>
      </div>
      <TemplatesBrowser
        templates={templates}
        sources={sources}
        existingProjects={projects.map((p) => p.name)}
        initialView={view}
      />
    </div>
  );
}
