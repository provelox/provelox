import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  devIndicators: false,
  // The image optimizer (and its native sharp) is not used: the one next/image is already unoptimized, and the platform
  // image leaves sharp out
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Cache-Control', value: 'no-store' },
          // Only over https (a browser ignores it on http): stay on https once it has been used
          { key: 'Strict-Transport-Security', value: 'max-age=15552000' },
          // No script policy here (Next's own inline scripts need a nonce), but nothing may frame, re-base or
          // repost the pages elsewhere
          {
            key: 'Content-Security-Policy',
            value:
              "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
