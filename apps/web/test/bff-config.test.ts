import assert from "node:assert/strict";
import test from "node:test";

import { isSameOriginRequest, shouldUseSecureCookies, stripTokens } from "../src/lib/bff-config";

test("stripTokens keeps upstream list responses as arrays", () => {
  const rows = [{ id: "1" }, { id: "2" }];

  const result = stripTokens(rows);

  assert.equal(result, rows);
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, rows);
});

test("stripTokens removes top-level credentials without mutating the payload", () => {
  const payload = {
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
    user: { id: "1" },
  };

  const result = stripTokens(payload);

  assert.deepEqual(result, { user: { id: "1" } });
  assert.equal(payload.accessToken, "secret-access");
});

test("state-changing BFF requests require trustworthy same-origin provenance", () => {
  const self = "https://panel.example.test";
  assert.equal(isSameOriginRequest("GET", new Headers(), self), true);
  assert.equal(isSameOriginRequest("POST", new Headers({ origin: self }), self), true);
  assert.equal(isSameOriginRequest("POST", new Headers({ referer: `${self}/products` }), self), true);
  assert.equal(isSameOriginRequest("POST", new Headers({ "sec-fetch-site": "same-origin" }), self), true);
  assert.equal(isSameOriginRequest("POST", new Headers({ origin: "https://evil.example" }), self), false);
  assert.equal(isSameOriginRequest("POST", new Headers({ referer: "https://evil.example/form" }), self), false);
  assert.equal(isSameOriginRequest("POST", new Headers({ "sec-fetch-site": "cross-site" }), self), false);
  assert.equal(isSameOriginRequest("POST", new Headers(), self), false);
});

test("BFF cookies are Secure only in production", () => {
  assert.equal(shouldUseSecureCookies("test"), false);
  assert.equal(shouldUseSecureCookies("development"), false);
  assert.equal(shouldUseSecureCookies("production"), true);
});
