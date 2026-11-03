import { redirect } from 'next/navigation';
import { afterLogin } from '@/lib/after-login';
import { getSession } from '@/lib/session';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = afterLogin((await searchParams).next);
  if (await getSession()) redirect(next);
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <LoginForm next={next} />
    </main>
  );
}
