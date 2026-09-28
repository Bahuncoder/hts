import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // No script-src: the App Router's own hydration payload is a series of
      // inline <script> tags with per-request content (verified against a
      // real build), so 'self' alone blocks the app from rendering at all.
      // The two real fixes both cost more than this is worth while there is
      // no injection point to protect against: a nonce (Next's documented
      // mechanism) forces every page to dynamic rendering, which would drop
      // this app's static/ISR pages (including the sitemap); experimental
      // Subresource Integrity was tried and confirmed NOT to cover this,
      // since SRI only hashes external script files, not inline content.
      // 'unsafe-inline' would satisfy the browser without stopping anything,
      // which is worse than being honest that this directive is absent.
      // Revisit if the app ever adds a real injection surface.
      { key: "Content-Security-Policy",
        value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
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
