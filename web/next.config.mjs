import path from 'node:path';

/**
 * Static export for GitHub Pages.
 *
 * Pages runs no server, so there is nothing here that can render on demand:
 * every screen is a client component talking to Supabase directly with the
 * anon key, and row-level security is what decides what comes back. See
 * docs/p0-tech-design.md §2.3.
 *
 * basePath is the repository name because a GitHub project site is served
 * from a subpath, not the domain root. Drop both if this ever moves to a
 * custom domain.
 */
const repo = 'DayBook-WebApp';
const isPages = process.env.GITHUB_PAGES === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  // Pages serves /foo/ rather than /foo, so emit directories with index.html.
  trailingSlash: true,
  basePath: isPages ? `/${repo}` : undefined,
  assetPrefix: isPages ? `/${repo}/` : undefined,
  // No server means no image optimiser.
  images: { unoptimized: true },
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
};

export default nextConfig;
