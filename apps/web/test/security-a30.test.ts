import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { POST } from "../src/app/api/bff/[...path]/route";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../src/lib/bff-config";
import { queryKeys } from "../src/lib/query-keys";
import { EMPTY_WIZARD, draftWithoutSecrets } from "../src/components/sections/platform-section";

const sourceRoot = path.join(__dirname, "..", "src");
const readSource = (...segments: string[]) => fs.readFileSync(path.join(sourceRoot, ...segments), "utf8");

test("security query keys are scoped to the concrete account", () => {
  assert.notDeepEqual(
    queryKeys.security.summary("app", "user-a", "suvera"),
    queryKeys.security.summary("app", "user-b", "suvera"),
  );
  assert.notDeepEqual(
    queryKeys.security.stepUp("app", "user-a"),
    queryKeys.security.stepUp("admin", "user-a"),
  );
  assert.notDeepEqual(
    queryKeys.security.policy("user-a", "suvera"),
    queryKeys.security.policy("user-a", "another-store"),
  );
});

test("A30 security is reachable for tenant and platform accounts", () => {
  const navigation = readSource("lib", "demo-data.ts");
  const content = readSource("components", "operations-content.tsx");
  const shell = readSource("components", "app-shell.tsx");
  assert.match(navigation, /\{ key: "security", label: "Güvenlik" \}/);
  assert.match(navigation, /^ {2}security: \{$/m);
  assert.match(content, /case "security":/);
  assert.match(content, /<SecuritySection currentRole=\{currentRole\} organizationSlug=\{activeOrganizationSlug\} \/>/);
  assert.match(shell, /\["superadmin", "security"\]\.includes\(activeSection\)/);
  assert.match(shell, /assurance\.enrollmentRequired \|\| assurance\.mfaChallengeRequired/);
});

test("passkey login is discoverable and does not identify an account from email", () => {
  const auth = readSource("lib", "api", "auth.ts");
  const login = readSource("app", "login", "page.tsx");
  assert.match(auth, /"\/auth\/passkey\/options"/);
  assert.match(auth, /"\/auth\/passkey\/verify"/);
  assert.match(login, /startAuthentication\(\{ optionsJSON: begun\.options \}\)/);
  const verifyPayload = /finishPasskeyLogin\(\{([\s\S]*?)\}\)/.exec(login)?.[1] ?? "";
  assert.doesNotMatch(verifyPayload, /email|userId|adminId/);
  assert.match(verifyPayload, /challengeId: begun\.challengeId/);
});

test("security UI keeps one-time material out of browser persistence", () => {
  const security = readSource("components", "sections", "security-section.tsx");
  const provider = readSource("components", "security", "step-up-provider.tsx");
  for (const source of [security, provider]) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
    assert.doesNotMatch(source, /console\.(log|info|warn|error)/);
  }
  assert.match(security, /setTotpSetup\(null\)/);
  assert.match(security, /setRecoveryCodes\(null\)/);
  assert.match(security, /challengeId: begun\.challengeId/);
  assert.match(provider, /pending\.action\(\)/);
  assert.match(provider, /getApiErrorCode\(cause\) !== "STEP_UP_REQUIRED"/);
});

test("critical admin mutations use the central step-up coordinator", () => {
  const expectations: Array<[string, RegExp[]]> = [
    ["integrations-section.tsx", [/runWithStepUp\(\(\) => createApiKey/, /runWithStepUp\(\(\) => rotateApiKey/, /runWithStepUp\(\(\) => rotateWebhookSecret/]],
    ["domains-section.tsx", [/runWithStepUp\(\(\) => releaseDomain/]],
    ["returns-section.tsx", [/runWithStepUp\(\(\) => refundReturn/]],
    ["subscription-section.tsx", [/runWithStepUp\(\(\) => requestPlanChange/, /runWithStepUp\(cancelAtPeriodEnd\)/, /runWithStepUp\(resumeSubscription\)/]],
    ["platform-section.tsx", [/runWithStepUp\(\(\) => impersonateStore/, /runWithStepUp\(\(\) => updatePlatformStorePlan/]],
    ["subscription-platform-panel.tsx", [/runWithStepUp\(\(\) => publishPlanVersion/, /runWithStepUp\(\(\) => transitionSubscription/, /runWithStepUp\(\(\) => retryBillingEvent/]],
  ];
  for (const [file, patterns] of expectations) {
    const source = readSource("components", "sections", file);
    for (const pattern of patterns) assert.match(source, pattern, `${file} is missing ${pattern}`);
  }
});

test("BFF stores passkey login tokens only in HttpOnly cookies", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    actorType: "app",
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    role: "owner",
    user: { id: "user-1", email: "owner@example.test", name: "Owner" },
    currentOrganization: { id: "org-1", name: "Suvera", slug: "suvera", role: "owner" },
    organizations: [{ id: "org-1", name: "Suvera", slug: "suvera", role: "owner" }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof global.fetch;

  try {
    const request = new NextRequest("http://localhost:3000/api/bff/auth/passkey/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ response: { id: "credential" }, challengeId: "challenge" }),
    });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["auth", "passkey", "verify"] }),
    });
    const body = await response.json() as Record<string, unknown>;
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.equal(response.status, 200);
    assert.equal("accessToken" in body, false);
    assert.equal("refreshToken" in body, false);
    assert.match(setCookie, new RegExp(`${ACCESS_COOKIE}=fixture-access-token`));
    assert.match(setCookie, new RegExp(`${REFRESH_COOKIE}=fixture-refresh-token`));
    assert.match(setCookie, /HttpOnly/i);
  } finally {
    global.fetch = originalFetch;
  }
});

// A30 storage gate. The super-admin new-store wizard keeps a draft in localStorage so a
// long form survives a reload. It must never carry the owner's password there: Web Storage
// outlives the tab and is readable by anything that runs on this origin.
test("the new-store wizard draft never carries the owner password into Web Storage", () => {
  const draft = draftWithoutSecrets({
    ...EMPTY_WIZARD,
    name: "Magaza",
    ownerEmail: "owner@example.com",
    ownerPassword: "Sup3rSecret!Value",
  });
  const serialized = JSON.stringify(draft);
  assert.equal("ownerPassword" in draft, false);
  assert.equal(serialized.includes("Sup3rSecret!Value"), false);
  assert.equal(JSON.parse(serialized).ownerEmail, "owner@example.com", "the rest of the draft still persists");

  // The only write to that key must go through the stripping helper.
  const source = readSource("components", "sections", "platform-section.tsx");
  assert.match(source, /setItem\(DRAFT_KEY, JSON\.stringify\(draftWithoutSecrets\(next\)\)\)/);
});
