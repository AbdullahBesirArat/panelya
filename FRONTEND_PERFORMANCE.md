# Frontend Performance Audit

## 1) 🔥 Performance Summary

Overall frontend performance health: **Medium**. The UI already has useful guardrails: search input is debounced, React Query has non-zero `staleTime`, list endpoints are capped at 50 rows, and the dependency set is small. The biggest remaining cost is not raw render complexity; it is **unnecessary work before the user can see and interact with data**.

Top 3 highest-impact problems:

- The dashboard data fetch is blocked behind the `/auth/me` check in `AppShell`, creating a likely network waterfall before every protected section renders.
- `OperationsContent` statically imports every section component, so one section route likely ships code for all dashboard sections.
- Section list queries replace the whole section with skeletons on filter/search key changes instead of keeping previous data during background refetches.

Biggest UX risk: **slow perceived TTI and janky filter interactions**. Users can see full-page loading states even when cached or previous section data could remain interactive.

## 2) ⚠️ Findings (Prioritized)

### 1. Auth Gate Creates A Protected-Page Network Waterfall

- **Category:** Network / Rendering / State
- **Severity:** High
- **Impact:** TTI, perceived latency, LCP of dashboard content
- **Evidence:** `apps/web/src/components/app-shell.tsx:31` fetches `["me", accessToken, organizationSlug]`; `apps/web/src/components/app-shell.tsx:106` returns only the "Oturum hazirlaniyor" shell while `isLoading` or `!data`; protected children are not mounted until this completes.
- **Why it's slow:** Section queries cannot start until `/auth/me` finishes. After that, the active section mounts and starts its summary/list queries. This serializes auth validation and page data instead of overlapping them.
- **Root Cause:** Auth freshness and route rendering are coupled in `AppShell`. Persisted session data exists in Zustand, but the shell treats the remote profile request as a hard render prerequisite.
- **Recommended Fix (Concrete):** Render the shell from persisted `user`, `organizations`, and `organizationSlug` after hydration, then run `/auth/me` as a background validation query. Only redirect on confirmed auth failure. Section queries can start as soon as an access token exists.
- **Tradeoffs:** Slightly more state handling is needed to avoid briefly showing stale workspace metadata after role/org changes. Security must still rely on API authorization, not UI gating.
- **Expected Impact:** Likely removes one round trip from protected-route TTI; best-case perceived load improves by the latency of `/auth/me` plus React mount time.
- **Fix Type:** Structural Fix
- **Classification:** Over-Engineered

### 2. All Dashboard Sections Are Statically Pulled Into One Client Entry

- **Category:** Bundle / CPU
- **Severity:** High
- **Impact:** Initial JS bytes, parse/compile time, route transition cost
- **Evidence:** `apps/web/src/components/operations-content.tsx:5` through `apps/web/src/components/operations-content.tsx:10` import all six sections; `apps/web/src/components/operations-content.tsx:20` selects one at runtime. Current `.next/static/chunks` total is about **772 KB uncompressed** from the latest local build output.
- **Why it's slow:** A user opening `/dashboard` likely downloads and parses code for products, orders, customers, analytics, and settings even when only one section is visible.
- **Root Cause:** Runtime switch in a single client component prevents section-level route splitting.
- **Recommended Fix (Concrete):** Use per-section route files or `next/dynamic` for section components:

```tsx
import dynamic from "next/dynamic";

const sectionComponents = {
  dashboard: dynamic(() => import("@/components/sections/dashboard-section").then((m) => m.DashboardSection)),
  products: dynamic(() => import("@/components/sections/products-section").then((m) => m.ProductsSection)),
  orders: dynamic(() => import("@/components/sections/orders-section").then((m) => m.OrdersSection)),
  customers: dynamic(() => import("@/components/sections/customers-section").then((m) => m.CustomersSection)),
  analytics: dynamic(() => import("@/components/sections/analytics-section").then((m) => m.AnalyticsSection)),
  settings: dynamic(() => import("@/components/sections/settings-section").then((m) => m.SettingsSection)),
};
```

- **Tradeoffs:** Adds async boundaries and must preserve loading/error UX. Route-level pages are cleaner but require more file movement.
- **Expected Impact:** Medium to high. Should reduce initial dashboard JS for single-section visits and improve parse/compile time, especially on mobile.
- **Fix Type:** Structural Fix
- **Classification:** Over-Engineered

### 3. Filter/Search Refetches Replace Stable Content With Full Skeletons

- **Category:** Rendering / Reactivity / Caching
- **Severity:** High
- **Impact:** INP, perceived responsiveness, layout stability
- **Evidence:** `apps/web/src/components/sections/products-section.tsx:72` changes query key by search/status/category; `apps/web/src/components/sections/products-section.tsx:170` returns `<SectionLoading />` when `productsQuery.isLoading`. Equivalent patterns exist in `orders-section.tsx:42` and `orders-section.tsx:65`, plus `customers-section.tsx:26` and `customers-section.tsx:32`.
- **Why it's slow:** On key changes, the old table can disappear and the whole section swaps to skeletons. This creates avoidable visual churn and removes controls while a small list request is in flight.
- **Root Cause:** Queries do not use `placeholderData`/previous data, and loading state is scoped to the whole section rather than the list panel.
- **Recommended Fix (Concrete):** Use React Query `placeholderData: keepPreviousData` for list queries, show a small `isFetching` indicator near filters, and reserve full-section skeletons only for first load with no cached data.
- **Tradeoffs:** Users may briefly see old results while a filter request is pending; the UI needs a clear "guncelleniyor" cue.
- **Expected Impact:** High perceived improvement. Filter interactions should stay stable and avoid full layout replacement.
- **Fix Type:** Quick Win
- **Classification:** Reuse Opportunity

### 4. Section Header Images Lack Responsive `sizes` And LCP Priority Control

- **Category:** Network / Layout
- **Severity:** Medium
- **Impact:** LCP, image bytes, mobile data use
- **Evidence:** `apps/web/src/components/page-kit.tsx:36` renders `next/image` with fixed `width`/`height`, remote Unsplash source, no `sizes`, no route-aware `priority`. The login page image at `apps/web/src/app/login/page.tsx:225` correctly uses `priority`, but also lacks `sizes`.
- **Why it's slow:** Without `sizes`, browsers can choose a larger responsive candidate than needed. Header images are above the fold, so the active section image can compete with data/API work for bandwidth.
- **Root Cause:** Shared image component does not describe rendered slot width across breakpoints.
- **Recommended Fix (Concrete):** Add `sizes="(min-width: 1024px) 340px, 100vw"` to `SectionHeader` images. Add a `priority` prop only for above-the-fold images that are consistently LCP candidates. Add `sizes="(min-width: 1024px) 50vw, 0px"` to the login image.
- **Tradeoffs:** Overusing `priority` can hurt other resources. Measure LCP before prioritizing every section image.
- **Expected Impact:** Medium. Likely reduces image transfer on mobile/tablet and stabilizes LCP candidate selection.
- **Fix Type:** Quick Win
- **Classification:** Reuse Opportunity

### 5. Date Formatting Allocates `Intl.DateTimeFormat` During Render

- **Category:** CPU / Rendering
- **Severity:** Low
- **Impact:** Render CPU in tables and summary lists
- **Evidence:** `apps/web/src/components/operations-shared.tsx:216` creates a new `Intl.DateTimeFormat` every `formatDateTime` call. Other formatters in the same module are already module-scoped.
- **Why it's slow:** `Intl.DateTimeFormat` construction is relatively expensive compared with `.format()`. The cost repeats for every date cell during render.
- **Root Cause:** Inconsistent formatter reuse.
- **Recommended Fix (Concrete):** Move the date formatter to module scope:

```ts
const dateTimeFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return dateTimeFormatter.format(new Date(value));
}
```

- **Tradeoffs:** None for the current fixed locale. If locale becomes user-configurable, key the formatter by locale.
- **Expected Impact:** Low alone; useful because it is near-zero risk.
- **Fix Type:** Quick Win
- **Classification:** Reuse Opportunity

### 6. Unused Presentational Components Stay In The Shared UI Module

- **Category:** Bundle / Code Quality
- **Severity:** Low
- **Impact:** Maintainability, possible client bundle bytes
- **Evidence:** `apps/web/src/components/page-kit.tsx:60` exports `DataTable`; `apps/web/src/components/page-kit.tsx:98` exports `ActivityList`; `rg` shows no imports outside their definitions.
- **Why it's slow:** If the module is included for `SectionHeader`/`MetricGrid`, unused exports can still add code depending on bundler tree-shaking and side-effect analysis. More importantly, duplicated table/activity concepts increase drift against `DataGrid`/`ActivityPanel`.
- **Root Cause:** Earlier UI helpers were left after the operations UI moved to shared components.
- **Recommended Fix (Concrete):** Remove `DataTable` and `ActivityList`, or move them to a dead-code parking file only if a planned screen still needs them.
- **Tradeoffs:** Verify no external imports are missed before removal.
- **Expected Impact:** Low runtime impact; medium maintainability value.
- **Fix Type:** Quick Win
- **Classification:** Dead Code

### 7. Toast Timers Are Recreated For All Toasts On Every Toast Array Change

- **Category:** Memory / Reactivity
- **Severity:** Low
- **Impact:** Minor timer churn
- **Evidence:** `apps/web/src/components/toast-viewport.tsx:16` maps over every toast and creates a timeout whenever `items` changes. The store caps items to four in `apps/web/src/store/toast.ts`, so this is bounded.
- **Why it's slow:** Adding or dismissing one toast resets timers for all visible toasts. It is not a current bottleneck because the array is tiny.
- **Root Cause:** Expiration is centralized in viewport effect rather than assigned per toast creation.
- **Recommended Fix (Concrete):** Leave as-is unless toast volume grows. If needed later, store `expiresAt` per toast or schedule a timer per toast component.
- **Tradeoffs:** Current code is simpler and bounded; changing it now is low ROI.
- **Expected Impact:** Very low.
- **Fix Type:** No immediate fix
- **Classification:** Not a current optimization target

## 3) ⚡ Quick Wins (Do First)

- Add `placeholderData: keepPreviousData` to products/orders/customers list queries and use `isFetching` instead of whole-section skeletons during filter changes.
- Add responsive `sizes` to `SectionHeader` and login `Image` components; measure LCP before adding broad `priority`.
- Reuse a module-scoped `Intl.DateTimeFormat`.
- Remove unused `DataTable` and `ActivityList` after one final `rg` check.

## 4) 🧱 Deeper Optimizations

- Decouple protected route rendering from `/auth/me` by rendering from hydrated persisted session and validating profile in the background.
- Split operations sections into route-level or dynamic chunks so `/dashboard` does not carry products/orders/settings code.
- Add optional RUM/web-vitals reporting for protected routes; Lighthouse alone will not capture authenticated dashboard behavior reliably.
- If row limits grow beyond 100-200, add server pagination controls first. Virtualization is unnecessary at the current `limit: 50`.

## 5) 📈 Validation Plan

Metrics:

- **LCP:** section header text/image on `/dashboard`, `/products`, `/orders`, and `/login`.
- **INP:** typing in product/order/customer search and changing filters.
- **TTI / user-perceived readiness:** time from navigation to first stable section content.
- **FPS / long tasks:** filter changes and table rerenders in Chrome Performance.
- **Memory:** long dashboard session with repeated navigation and toast creation.
- **Bundle size:** route JS bytes before/after section splitting.

Tools:

- Chrome DevTools Performance tab with 4x CPU slowdown and Fast 3G/Slow 4G presets.
- React DevTools Profiler for section filter interactions.
- `next build` output and `.next/static/chunks` size comparison.
- Web Vitals instrumentation for authenticated routes.
- Lighthouse only as a secondary check for login/public flows.

Before/after strategy:

- Record `/dashboard` load with a warm local session: confirm whether `/auth/me` completes before `/organizations/current/summary` starts.
- Type a 5-character product search and compare whether controls/table remain mounted during refetch.
- Compare total and per-route client JS after dynamic/route-level section splitting.
- Compare LCP and transferred image bytes after adding `sizes`.

## 6) 🧩 Optimized Code (if possible)

Recommended first patch shape:

```tsx
import { keepPreviousData, useQuery } from "@tanstack/react-query";

const productsQuery = useQuery({
  queryKey: ["products", organizationSlug, debouncedSearch, status, categoryId],
  queryFn: () => fetchProducts({ q: debouncedSearch, status, categoryId, limit: 50 }),
  staleTime: 15_000,
  placeholderData: keepPreviousData,
});

const showInitialLoading =
  summaryQuery.isLoading ||
  categoriesQuery.isLoading ||
  (productsQuery.isLoading && !productsQuery.data);
```

Why this is faster: it avoids tearing down the section on filter/search changes, keeps the input/table interactive, and converts a full-screen wait into a background fetch state.

Recommended image patch shape:

```tsx
<Image
  alt=""
  className="h-56 w-full rounded-lg object-cover shadow-panel lg:h-full"
  height={720}
  sizes="(min-width: 1024px) 340px, 100vw"
  src={image}
  width={960}
/>
```

Why this is faster: it gives the browser enough slot-size information to avoid downloading unnecessarily large image variants for the rendered header width.
