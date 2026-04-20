import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  // Force Next.js to bundle these packages instead of treating them as
  // externals. agora-agent-uikit and agora-agent-client-toolkit ship ESM
  // files with "use client" directives at the top; without transpilePackages,
  // Turbopack/webpack's RSC layer can wrap their exports as client boundary
  // references (undefined at runtime) instead of inlining the real components.
  transpilePackages: [
    'agora-agent-uikit',
    'agora-agent-client-toolkit',
    'agora-rtc-react',
  ],
  turbopack: {
    root: rootDir,
  },
  experimental: {
    webpackBuildWorker: true,
    parallelServerBuildTraces: true,
    parallelServerCompiles: true,
  },
};

export default nextConfig;
