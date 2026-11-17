/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  distDir: process.env.JAYTRACE_NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
