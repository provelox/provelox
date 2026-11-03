import { LogsViewer } from './logs-viewer';

export default async function LogsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <LogsViewer appName={name} />;
}
