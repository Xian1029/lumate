import type { NextConfig } from "next";
import path from "path";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000/api";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-XSS-Protection", value: "1; mode=block" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ${API_URL.replace(/\/api$/, "")}${process.env.NODE_ENV === "development" ? " http://localhost:* ws://localhost:*" : ""}`,
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  // Prevent Next.js from issuing 308 redirects for trailing slashes on /api/* paths.
  // Without this, POST /api/courses/ gets a 308 before the rewrite runs, and the
  // redirected request may expose the backend origin, which CSP connect-src blocks.
  skipTrailingSlashRedirect: true,
  // Next.js proxies `/api/*` to FastAPI. Its proxy layer caps request bodies at
  // 10MB by default, which silently truncates large multipart uploads (>10MB)
  // and makes FastAPI hang up the socket (ECONNRESET → 500 "Internal Server
  // Error"). Raise it above the backend's 500MB upload limit (plus multipart
  // boundary/field overhead) so PDF/PPTX uploads flow through intact.
  experimental: {
    proxyClientMaxBodySize: 550 * 1024 * 1024,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    return {
      // beforeFiles ensures the API proxy runs before Next.js file matching
      // and trailing slash normalization, preventing 308 redirect races.
      beforeFiles: [
        {
          source: "/api/courses",
          destination: `${API_URL}/courses/`,
        },
        {
          source: "/api/courses/",
          destination: `${API_URL}/courses/`,
        },
        // The FastAPI list/create route is canonical with a trailing slash.
        // Next's normalisation can otherwise forward the no-slash URL and
        // expose FastAPI's 307 redirect to the browser.  A direct local API
        // redirect then becomes cross-origin and its CORS preflight fails.
        {
          source: "/api/learning-plans",
          destination: `${API_URL}/learning-plans/`,
        },
        {
          // FastAPI serves chat SSE on `/api/chat/` and responds with an
          // absolute 307 redirect if the trailing slash is lost. Handle chat
          // explicitly so the browser stays on the Next.js origin.
          source: "/api/chat",
          destination: `${API_URL}/chat/`,
        },
        {
          source: "/api/chat/",
          destination: `${API_URL}/chat/`,
        },
        {
          source: "/api/:path*",
          destination: `${API_URL}/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
