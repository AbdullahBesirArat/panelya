import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET, POST, upstreamFailureReason } from "../src/app/api/bff/[...path]/route";
import { needsRefreshCookieInjection } from "../src/lib/bff-config";

// Regression guard for A20 catalog import upload: the BFF must forward a
// multipart/form-data body to the upstream API byte-for-byte and must never
// re-serialize it as JSON (which would corrupt the multipart boundary and drop
// the uploaded file).

const BOUNDARY = "----panelyaImportBoundary";
function multipartBody() {
  const text = [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="type"',
    "",
    "product_upsert",
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="file"; filename="urunler.csv"',
    "Content-Type: text/csv",
    "",
    "sku,name,price\r\nSUV-1,Bluz,120",
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
  return Buffer.from(text, "utf8");
}

// A30. Every BFF 502 used to look identical, so a budget set below an endpoint's real
// service time was indistinguishable from a dead upstream. The reason must separate them.
test("a BFF 502 reports why the upstream call failed", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError", code: 20 });
  assert.equal(upstreamFailureReason(abort, true), "bff_timeout");
  assert.equal(upstreamFailureReason(abort, false), "client_aborted");
  assert.equal(
    upstreamFailureReason(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), false),
    "ECONNREFUSED"
  );
  assert.equal(
    upstreamFailureReason(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), false),
    "ECONNRESET"
  );
  assert.equal(upstreamFailureReason(new Error("boom"), false), "Error");
});

test("import preview is never a JSON-injection path", () => {
  assert.equal(needsRefreshCookieInjection("imports/preview"), false);
  assert.equal(needsRefreshCookieInjection("auth/session/refresh"), true);
});

test("BFF forwards multipart import uploads byte-for-byte without JSON conversion", async () => {
  const body = multipartBody();
  const contentType = `multipart/form-data; boundary=${BOUNDARY}`;
  const captured: { url?: string; contentType?: string | null; body?: Buffer } = {};

  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    const headers = new Headers(init?.headers);
    captured.contentType = headers.get("content-type");
    captured.body = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
    return new Response(JSON.stringify({ id: "job-1", status: "previewed" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof global.fetch;

  try {
    const req = new NextRequest("http://localhost:3000/api/bff/imports/preview", {
      method: "POST",
      headers: { "content-type": contentType, "sec-fetch-site": "same-origin" },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ path: ["imports", "preview"] }) });

    assert.equal(res.status, 201);
    assert.equal(captured.url, "http://localhost:3000/api/imports/preview");
    assert.equal(captured.contentType, contentType);
    assert.ok(captured.body, "upstream received a body");
    assert.equal(Buffer.compare(captured.body as Buffer, body), 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("BFF forwards only same-origin OAuth callback locations", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async () => new Response(null, { status: 303, headers: { location: "/products?tab=instagram" } })) as typeof global.fetch;
    const safe = await GET(new NextRequest("http://localhost:3000/api/bff/instagram-imports/oauth/callback?code=x&state=y", {
      headers: { "sec-fetch-site": "same-origin" },
    }), { params: Promise.resolve({ path: ["instagram-imports", "oauth", "callback"] }) });
    assert.equal(safe.headers.get("location"), "/products?tab=instagram");

    global.fetch = (async () => new Response(null, { status: 303, headers: { location: "https://evil.example/steal" } })) as typeof global.fetch;
    const unsafe = await GET(new NextRequest("http://localhost:3000/api/bff/instagram-imports/oauth/callback?code=x&state=y", {
      headers: { "sec-fetch-site": "same-origin" },
    }), { params: Promise.resolve({ path: ["instagram-imports", "oauth", "callback"] }) });
    assert.equal(unsafe.headers.get("location"), null);
  } finally { global.fetch = originalFetch; }
});

test("BFF forwards only well-formed idempotency keys", async () => {
  const originalFetch = global.fetch;
  const seen: Array<string | null> = [];
  global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("idempotency-key"));
    return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof global.fetch;
  try {
    for (const key of ["instagram-ui:12345678", "bad key with spaces"]) {
      await POST(new NextRequest("http://localhost:3000/api/bff/instagram-imports/drafts/d1/apply", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, "sec-fetch-site": "same-origin" }, body: "{}",
      }), { params: Promise.resolve({ path: ["instagram-imports", "drafts", "d1", "apply"] }) });
    }
    assert.deepEqual(seen, ["instagram-ui:12345678", null]);
  } finally { global.fetch = originalFetch; }
});
