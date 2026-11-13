import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  transpilePackages: ["@universe/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  webpack: (config) => {
    // @universe/core uses ESM-style ".js" import specifiers for .ts files.
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default nextConfig;
