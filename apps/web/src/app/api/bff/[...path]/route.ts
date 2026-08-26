import { NextRequest, NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ADMIN_RESTORE_COOKIE,
  ACCESS_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  RESTORE_COOKIE_MAX_AGE,
  upstreamApiOrigin,
  upstreamAssetOrigin,
  isLegacyUploadPath,
  isSameOriginRequest,
  stripTokens,
  isImpersonationStart,
  isLogoutPath,
  needsRefreshCookieInjection,
  shouldUseSecureCookies,
} from "@/lib/bff-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = Number(process.env.BFF_TIMEOUT_MS) > 0 ? Number(process.env.BFF_TIMEOUT_MS) : 15000;

type CookieOpts = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge?: number;
};

function cookieOptions(maxAge?: number): CookieOpts {
  const opts: CookieOpts = {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/api/bff",
  };
  if (maxAge != null) opts.maxAge = maxAge;
  return opts;
}

// Why the upstream call failed, in terms a log reader can act on. `timedOut` separates
// "we gave up" from "the connection broke", which are opposite problems: the first is a
// budget that is too small for the endpoint, the second is an upstream that is down or
// dropping connections.
export function upstreamFailureReason(error: unknown, timedOut: boolean): string {
  if (timedOut) return "bff_timeout";
  const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  // An abort carries DOMException code 20, which says nothing useful; the fact that it
  // was aborted at all is the finding, so it is read before any numeric code.
  if (err?.name === "AbortError") return "client_aborted";
  const code = err?.code || err?.cause?.code;
  if (code) return String(code);
  return err?.name || "unknown";
}

function logUpstreamFailure(detail: {
  method: string;
  path: string;
  upstream: string;
  elapsedMs: number;
  budgetMs: number;
  timedOut: boolean;
  error: unknown;
}) {
  const err = detail.error as { name?: string; code?: string; cause?: { code?: string } } | null;
  console.warn("bff_upstream_failure", {
    method: detail.method,
    path: detail.path,
    upstream: detail.upstream,
    elapsedMs: detail.elapsedMs,
    budgetMs: detail.budgetMs,
    reason: upstreamFailureReason(detail.error, detail.timedOut),
    errorName: err?.name,
    errorCode: err?.code,
    causeCode: err?.cause?.code,
  });
}

function injectRefreshToken(buf: Buffer, refreshToken: string): { body: Buffer; contentType?: string } {
  let payload: Record<string, unknown> = {};
  try {
    payload = buf.length ? JSON.parse(buf.toString("utf8")) : {};
  } catch {
    payload = {};
  }
  if (typeof payload.refreshToken === "string" && payload.refreshToken) {
    return { body: buf };
  }
  payload.refreshToken = refreshToken;
  return { body: Buffer.from(JSON.stringify(payload)), contentType: "application/json" };
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const { path = [] } = await ctx.params;
  const joined = path.join("/");
  // Next's dev server may normalize req.url to `localhost` even when the
  // browser reached 127.0.0.1. Derive the public origin from the actual Host
  // header (and the trusted proxy protocol at deployment) so legitimate
  // same-origin requests are not rejected while host mismatches still fail.
  const requestUrl = new URL(req.url);
  const host = req.headers.get("host") || requestUrl.host;
  const forwardedProtocol = (req.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim();
  const protocol = forwardedProtocol || requestUrl.protocol.replace(/:$/, "");
  const selfOrigin = `${protocol}://${host}`;

  if (!isSameOriginRequest(req.method, req.headers, selfOrigin)) {
    return NextResponse.json({ error: "Forbidden request" }, { status: 403 });
  }

  // Local (non-proxied) route: return from impersonation by restoring the
  // super-admin access token that was parked in an HttpOnly cookie.
  if (joined === "session/stop-impersonation" && req.method === "POST") {
    const restore = req.cookies.get(ADMIN_RESTORE_COOKIE)?.value;
    const res = NextResponse.json({ ok: true, restored: Boolean(restore) });
    if (restore) {
      res.cookies.set(ACCESS_COOKIE, restore, cookieOptions(ACCESS_COOKIE_MAX_AGE));
    } else {
      res.cookies.set(ACCESS_COOKIE, "", cookieOptions(0));
    }
    res.cookies.set(ADMIN_RESTORE_COOKIE, "", cookieOptions(0));
    return res;
  }

  const url = new URL(req.url);
  // Legacy `/uploads/<file>` assets sit at the API root rather than under `/api`.
  const legacyUpload = isLegacyUploadPath(req.method, joined);
  const upstreamBase = legacyUpload ? upstreamAssetOrigin() : upstreamApiOrigin();
  const upstreamUrl = `${upstreamBase}/${joined}${url.search}`;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const idempotencyKey = req.headers.get("idempotency-key");
  if (idempotencyKey && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
    headers.set("idempotency-key", idempotencyKey);
  }
  const accessToken = req.cookies.get(ACCESS_COOKIE)?.value;
  // Legacy uploads are public static bytes; the session token has no business there.
  if (accessToken && !legacyUpload) headers.set("authorization", `Bearer ${accessToken}`);

  const method = req.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  let bodyBuf: Buffer | undefined;
  if (hasBody) {
    bodyBuf = Buffer.from(await req.arrayBuffer());
    if (needsRefreshCookieInjection(joined)) {
      const rt = req.cookies.get(REFRESH_COOKIE)?.value;
      if (rt) {
        const injected = injectRefreshToken(bodyBuf, rt);
        bodyBuf = injected.body;
        if (injected.contentType) headers.set("content-type", injected.contentType);
      }
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: hasBody && bodyBuf ? new Uint8Array(bodyBuf) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(timer);
    // A 502 here used to be indistinguishable from a dead upstream, which cost a whole
    // debugging cycle. Record why, and nothing else: no headers, cookies, tokens or body
    // ever reach this log — only the route shape, the upstream origin and the timings.
    logUpstreamFailure({
      method,
      path: joined,
      upstream: upstreamApiOrigin(),
      elapsedMs: Date.now() - startedAt,
      budgetMs: TIMEOUT_MS,
      timedOut,
      error,
    });
    return NextResponse.json({ error: "Upstream request failed" }, { status: 502 });
  }
  clearTimeout(timer);

  const respContentType = upstream.headers.get("content-type") || "";
  const rawBuf = Buffer.from(await upstream.arrayBuffer());

  if (!respContentType.includes("application/json")) {
    const res = new NextResponse(rawBuf, { status: upstream.status });
    res.headers.set("content-type", respContentType || "application/octet-stream");
    const contentDisposition = upstream.headers.get("content-disposition");
    if (contentDisposition) res.headers.set("content-disposition", contentDisposition);
    const location = upstream.headers.get("location");
    // OAuth callbacks may return to a dashboard page, but the upstream can only choose
    // an absolute-path location on this origin. Never turn the BFF into an open redirect.
    if (location?.startsWith("/") && !location.startsWith("//")) res.headers.set("location", location);
    res.headers.set("x-content-type-options", "nosniff");
    if (isLogoutPath(joined)) clearAuthCookies(res);
    return res;
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = rawBuf.length ? JSON.parse(rawBuf.toString("utf8")) : {};
  } catch {
    payload = {};
  }

  const outgoing = upstream.ok ? stripTokens(payload) : payload;
  const res = NextResponse.json(outgoing, { status: upstream.status });

  if (upstream.ok && payload && typeof payload === "object") {
    const newAccess = typeof payload.accessToken === "string" ? payload.accessToken : "";
    const newRefresh = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
    if (newAccess) {
      if (isImpersonationStart(joined) && accessToken) {
        // Park the super-admin token so "return to platform" needs no client token.
        res.cookies.set(ADMIN_RESTORE_COOKIE, accessToken, cookieOptions(RESTORE_COOKIE_MAX_AGE));
      }
      res.cookies.set(ACCESS_COOKIE, newAccess, cookieOptions(ACCESS_COOKIE_MAX_AGE));
    }
    if (newRefresh) {
      res.cookies.set(REFRESH_COOKIE, newRefresh, cookieOptions(REFRESH_COOKIE_MAX_AGE));
    }
  }

  if (isLogoutPath(joined)) clearAuthCookies(res);
  return res;
}

function clearAuthCookies(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE, "", cookieOptions(0));
  res.cookies.set(REFRESH_COOKIE, "", cookieOptions(0));
  res.cookies.set(ADMIN_RESTORE_COOKIE, "", cookieOptions(0));
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
