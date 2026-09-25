import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A stray lockfile in the home directory makes Next guess the wrong
  // workspace root, which mis-traces the files a deployment needs.
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
};

export default nextConfig;
