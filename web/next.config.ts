import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Saving an audit sends its lines to a server action, and the default
    // 1 MB cap is under what a full 1,000-product catalogue serialises to.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
