import 'server-only';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { loadApps } from './backend';
import { withSession } from './with-session';

/**
 * Every app, as the dashboard's shell and an app's own page both need them: one call to the API per page load however
 * many layouts and pages ask (`cache` shares the answer within a render).
 */
export const getApps = cache(() => withSession((token) => loadApps(token)));

/**
 * Loads one app for a server page; signs out cleanly if the token expired, 404s if the app is gone. An app's layout and
 * its page both ask for it while one page is rendered: `cache` makes that one call to the API instead of two.
 */
export const getApp = cache(async (name: string) => {
  const data = await getApps();
  const app = data.appDefinitions.find((a) => a.appName === name);
  if (!app) notFound();
  // The other services of the project this app belongs to, if any
  const projectApps = app.project
    ? data.appDefinitions
        .filter((a) => a.project === app.project)
        .map((a) => a.appName)
    : [];
  return {
    app,
    rootDomain: data.rootDomain,
    ports: data.ports,
    projectApps,
    allApps: data.appDefinitions.map((a) => a.appName),
  };
});
