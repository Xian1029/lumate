import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://api:8000/api";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Stream large multipart uploads to FastAPI.
 *
 * Next's generic rewrite/proxy path clones request bodies and applies a 10MB
 * default buffer. This dedicated route never buffers the body, so textbook
 * PDFs larger than 10MB reach the API intact.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const headers = new Headers(request.headers);

  // Let undici calculate framing for the streamed request. Preserve
  // content-type (including the multipart boundary) and cookies/auth headers.
  headers.delete("content-length");
  headers.delete("host");
  // Undici does not support forwarding curl/node's `Expect: 100-continue`
  // header; the streamed request can be sent immediately instead.
  headers.delete("expect");

  const upstream = await fetch(`${API_URL}/content/upload`, {
    method: "POST",
    headers,
    body: request.body,
    // Node's fetch requires this for a ReadableStream request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
