import type { NextConfig } from "next";

// @velotech/* libs ship TypeScript source (main = src/index.ts), so Next must
// transpile them rather than expecting pre-built JS.
const nextConfig: NextConfig = {
  output: "standalone", // slim runtime image (Docker runner copies .next/standalone)
  transpilePackages: ["@velotech/auth-kit", "@velotech/ui"],
};

export default nextConfig;
