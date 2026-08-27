import type { NextConfig } from "next";

/**
 * Security headers. Applied globally via `headers()` rather than
 * per-route, since there's no reason any route should lack them.
 *
 * CSP note: this is a deliberately conservative starting policy. Phase 21
 * (Frontend Command Center) and Phase 26 (WebGL grid-distortion effect)
 * may need to loosen specific directives (e.g. for inline styles a
 * charting library injects, or WebGL/worker requirements) -- if so, widen
 * the specific directive that needs it and document why in this file's
 * comments, rather than relaxing the policy broadly.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js dev mode needs 'unsafe-eval' for hot module reload;
      // production builds don't. Tighten to drop 'unsafe-eval' once a
      // production deployment target exists to verify against (Docker
      // build, Phase 30).
      "script-src 'self' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
