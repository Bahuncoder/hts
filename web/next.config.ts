import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
  experimental: {
    // Saving an audit sends its lines to a server action, and the default
    // 1 MB cap is under what a full catalogue serialises to.
    serverActions: { bodySizeLimit: "4mb" },
  },
  // The pricing page is gone: HTSDesk is free. Old links and bookmarks land
  // on the home page instead of a 404.
  async redirects() {
    return [{ source: "/pricing", destination: "/", permanent: true }];
  },
};

export default nextConfig;
