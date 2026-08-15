import assert from "node:assert/strict";
import test from "node:test";
import { STOREFRONT_API_BASE } from "../src/lib/api/core";
import { resolveApiAssetUrl } from "../src/lib/api/media";

const API_BASE = "https://api.example.test/api";

test("storefront configuration keeps browser API traffic on the same origin", () => {
  assert.equal(STOREFRONT_API_BASE, "/api");
});

test("media URL resolver keeps absolute HTTP assets unchanged", () => {
  assert.equal(
    resolveApiAssetUrl("https://cdn.example.test/item.webp", API_BASE),
    "https://cdn.example.test/item.webp",
  );
});

test("media URL resolver maps upload and API paths to the upstream origin", () => {
  assert.equal(resolveApiAssetUrl("/uploads/item.webp", API_BASE), "https://api.example.test/uploads/item.webp");
  assert.equal(resolveApiAssetUrl("uploads/item.webp", API_BASE), "https://api.example.test/uploads/item.webp");
  assert.equal(resolveApiAssetUrl("/api/media/42/card", API_BASE), "https://api.example.test/api/media/42/card");
  assert.equal(resolveApiAssetUrl("legacy.webp", API_BASE), "https://api.example.test/uploads/legacy.webp");
});

test("media URL resolver preserves the empty value contract", () => {
  assert.equal(resolveApiAssetUrl("", API_BASE), "");
  assert.equal(resolveApiAssetUrl(null, API_BASE), "");
});
