import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export so the app can be bundled into a Tauri desktop executable.
  output: "export",
  // Note: `cacheComponents` / `partialPrefetching` (PPR) are incompatible with `output: "export"`.
  turbopack: {
    resolveAlias: {
      "jsdom/lib/jsdom/living/generated/utils": false,
      jsdom: false,
      canvas: false,
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "jsdom/lib/jsdom/living/generated/utils": false,
      jsdom: false,
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
