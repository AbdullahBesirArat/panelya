import { authenticatedRequest, buildQuery } from "./core";
import type { ApiCustomer } from "./types";

export async function fetchCustomers(filters: { q?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal) {
  return authenticatedRequest<ApiCustomer[]>(
    `/customers${buildQuery({
      q: filters.q,
      limit: filters.limit,
      offset: filters.offset,
    })}`,
    { signal },
  );
}
