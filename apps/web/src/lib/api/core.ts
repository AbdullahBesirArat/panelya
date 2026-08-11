import { useSessionStore } from "@/store/session";
import { ApiError, type SessionResponse } from "./types";

// Real upstream origin is used only for public asset URLs/config snippets.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3000/api";
const REQUEST_BASE = "/api/bff";

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  return undefined as T;
}

async function readError(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};
  const status = response.status;
  const serverMessage = typeof body.error === "string" ? body.error : "";
  const requestId = typeof body.requestId === "string" ? body.requestId : null;
  // Preserve the backend code on every branch: callers branch on this, not on the message.
  const serverCode = typeof body.code === "string" ? body.code : null;

  if (status === 401) {
    throw new ApiError("Oturumunuz gecersiz veya suresi dolmus.", status, requestId, serverCode);
  }
  if (status === 403) {
    throw new ApiError("Bu işlem için yetkiniz yok.", status, requestId, serverCode);
  }
  if (status === 404) {
    throw new ApiError("Istenen kayit bulunamadi.", status, requestId, serverCode);
  }
  if (status === 409) {
    throw new ApiError("Bu işlem mevcut verilerle çakıştı.", status, requestId, serverCode);
  }
  if (status === 429) {
    throw new ApiError("Cok fazla istek gonderildi. Lutfen biraz sonra tekrar deneyin.", status, requestId, serverCode);
  }
  if (status >= 500) {
    throw new ApiError("Sunucuda bir hata olustu. Lutfen tekrar deneyin.", status, requestId, serverCode);
  }

  throw new ApiError(serverMessage || "Islem tamamlanamadi. Girdilerinizi kontrol edip tekrar deneyin.", status, requestId, serverCode);
}

export function buildQuery(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });

  const query = search.toString();
  return query ? `?${query}` : "";
}

export async function publicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body != null && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${REQUEST_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (!response.ok) await readError(response);
  return parseResponse<T>(response);
}

let refreshSessionPromise: Promise<boolean> | null = null;
// Advances on every successful refresh. A request that received a 401 with an
// already-replaced access token can detect that a refresh completed while it was
// in flight and retry instead of starting a redundant second refresh, so a burst
// of stale-token 401s shares exactly one refresh even when they arrive staggered
// around the refresh finishing.
let sessionRefreshGeneration = 0;

// Single-flight refresh. The refresh token is supplied by the BFF from an
// HttpOnly cookie, so no token is read from or sent by client JavaScript.
async function tryRefreshSession({ clearOnFailure = true } = {}) {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  const state = useSessionStore.getState();
  if (!state.authenticated) return false;

  refreshSessionPromise = (async () => {
    try {
      const refreshed = await publicRequest<SessionResponse>("/auth/session/refresh", {
        method: "POST",
        body: JSON.stringify({
          organizationSlug: state.organizationSlug,
        }),
      });
      useSessionStore.getState().applySession(refreshed);
      sessionRefreshGeneration += 1;
      return true;
    } catch {
      if (clearOnFailure) {
        useSessionStore.getState().clearSession();
      }
      return false;
    } finally {
      refreshSessionPromise = null;
    }
  })();

  return refreshSessionPromise;
}

export async function keepSessionAlive() {
  return tryRefreshSession({ clearOnFailure: false });
}

export async function authenticatedRequest<T>(path: string, options: RequestInit = {}, canRetry = true): Promise<T> {
  const state = useSessionStore.getState();
  const headers = new Headers(options.headers);

  if (options.body != null && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  // Snapshot the refresh generation before sending so a 401 can tell whether the
  // session was already refreshed by a concurrent request while this one was in
  // flight.
  const generationAtSend = sessionRefreshGeneration;

  // No Authorization header: the same-origin BFF injects the bearer token from
  // the HttpOnly access cookie. `credentials: "include"` sends that cookie.
  const response = await fetch(`${REQUEST_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (response.status === 401 && canRetry && state.authenticated) {
    // A concurrent refresh already renewed the session: this 401 is from the
    // superseded access token, so retry once with the fresh cookie instead of
    // starting another refresh.
    if (sessionRefreshGeneration !== generationAtSend) {
      return authenticatedRequest<T>(path, options, false);
    }
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return authenticatedRequest<T>(path, options, false);
    }
  }

  if (!response.ok) await readError(response);
  return parseResponse<T>(response);
}

// The E2E build exposes one narrow hook so Playwright can prove that concurrent
// 401 responses share a single refresh request. This branch is eliminated from
// normal production builds because the public flag is never enabled there.
if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_E2E_TEST_MODE === "true") {
  (window as typeof window & {
    __PANELYA_E2E_AUTH_BURST__?: (paths: string[]) => Promise<PromiseSettledResult<unknown>[]>;
  }).__PANELYA_E2E_AUTH_BURST__ = (paths) => Promise.allSettled(
    paths.map((path) => authenticatedRequest(path))
  );
}
