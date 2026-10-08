import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export so the app can be bundled into a Tauri desktop executable.
  output: "export",
  // Note: `cacheComponents` / `partialPrefetching` (PPR) are incompatible with `output: "export"`.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
