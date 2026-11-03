import Image from 'next/image';
import { cn } from '@/lib/utils';

// The official mark lives in public/icon.svg. The wordmark stays live text so it follows the light and dark themes
// (public/logo.svg has fixed dark lettering).
export function LogoMark({ className }: { className?: string }) {
  return (
    <Image
      src="/icon.svg"
      alt=""
      width={153}
      height={187}
      unoptimized
      aria-hidden="true"
      className={cn('h-6 w-auto shrink-0', className)}
    />
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-base font-bold tracking-tight">
        Provelo<span className="text-[#3B82F6]">x</span>
      </span>
    </span>
  );
}
