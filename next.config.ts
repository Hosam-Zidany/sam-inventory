import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// The app is a fully static export so it can be hosted on GitHub Pages.
// All data access happens in the browser against Supabase (RLS + RPCs).
// On Pages the site lives under /<repo-name>; the deploy workflow sets
// NEXT_PUBLIC_BASE_PATH for that. Leave it empty for local dev / a custom domain.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: basePath || undefined,
  reactStrictMode: true,
};

export default withNextIntl(config);
