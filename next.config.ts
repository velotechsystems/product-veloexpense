import type { NextConfig } from "next";

// @velotech/* libs ship TypeScript source (main = src/index.ts), so Next must
// transpile them rather than expecting pre-built JS.
const nextConfig: NextConfig = {
  transpilePackages: ["@velotech/auth-kit", "@velotech/ui"],
};

export default nextConfig;
