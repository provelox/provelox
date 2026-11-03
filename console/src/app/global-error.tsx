'use client';

import './globals.css';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { WaitingScreen } from '@/components/waiting-screen';
import { themeScript } from '@/lib/theme';

const fontSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
});

/**
 * Catches what the root layout and the signed-in frame cannot: when the page's own layout fails (the API being down
 * is the usual reason), Next would otherwise show its bare default error. This replaces the whole document.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className={fontSans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <title>Provelox</title>
      </head>
      <body className="font-sans">
        <WaitingScreen variant="error" digest={error.digest} reset={reset} />
      </body>
    </html>
  );
}
