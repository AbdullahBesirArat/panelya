import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { STOREFRONT_API_BASE } from "../src/lib/api/core";
import {
  MAX_MEDIA_UPLOAD_BYTES, resolveApiAssetUrl, toBffAssetPath, validateMediaUpload,
} from "../src/lib/api/media";
import { dashboardMediaUrl } from "../src/lib/api/instagram-import";
import { isLegacyUploadPath } from "../src/lib/bff-config";

test("storefront configuration keeps browser API traffic on the same origin", () => {
  assert.equal(STOREFRONT_API_BASE, "/api");
});

test("media URL resolver keeps absolute HTTP assets unchanged", () => {
  assert.equal(
    resolveApiAssetUrl("https://cdn.example.test/item.webp"),
    "https://cdn.example.test/item.webp",
  );
  assert.equal(
    resolveApiAssetUrl("http://cdn.example.test/item.webp"),
    "http://cdn.example.test/item.webp",
  );
});

test("media URL resolver maps upload and API paths onto the same-origin BFF", () => {
  assert.equal(resolveApiAssetUrl("/api/media/42/card"), "/api/bff/media/42/card");
  assert.equal(
    resolveApiAssetUrl("/api/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/detail"),
    "/api/bff/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/detail",
  );
  assert.equal(resolveApiAssetUrl("/uploads/item.webp"), "/api/bff/uploads/item.webp");
  assert.equal(resolveApiAssetUrl("uploads/item.webp"), "/api/bff/uploads/item.webp");
  assert.equal(resolveApiAssetUrl("legacy.webp"), "/api/bff/uploads/legacy.webp");
});

// The bug this file guards: on the production dashboard the resolver prepended the
// client-side upstream origin, which without NEXT_PUBLIC_API_BASE_URL was
// `http://localhost:3000` — every preview became ERR_CONNECTION_REFUSED and a
// mixed-content warning on an HTTPS page. A resolved asset URL is now either the
// absolute URL it already was, or a path with no origin at all.
test("resolved media URLs never carry an upstream or localhost origin", () => {
  const inputs = [
    "/api/media/42/detail",
    "/api/media/42/card",
    "/api/media/42/thumbnail",
    "/uploads/item.webp",
    "uploads/item.webp",
    "legacy.webp",
    "/api/uploads/item.webp",
  ];
  for (const input of inputs) {
    const resolved = resolveApiAssetUrl(input);
    assert.ok(resolved.startsWith("/"), `${input} resolves to a same-origin path`);
    assert.ok(!/^\/\//.test(resolved), `${input} is not protocol-relative`);
    assert.ok(!resolved.includes("localhost"), `${input} never points at localhost`);
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(resolved), `${input} carries no scheme`);
  }
});

// Local development is served by the same relative paths: the Next dev server owns
// `/api/bff` on its own origin, so no environment-specific branch is needed.
test("the resolver is origin independent, so local dev and production agree", () => {
  assert.equal(resolveApiAssetUrl("/api/media/42/detail"), "/api/bff/media/42/detail");
  assert.equal(toBffAssetPath("/api/media/42/detail"), "/api/bff/media/42/detail");
  assert.equal(toBffAssetPath("https://cdn.example.test/item.webp"), "");
});

test("media URL resolver preserves the empty value contract", () => {
  assert.equal(resolveApiAssetUrl(""), "");
  assert.equal(resolveApiAssetUrl(null), "");
  assert.equal(resolveApiAssetUrl(undefined), "");
  assert.equal(resolveApiAssetUrl("   "), "");
});

test("media upload rejects unsafe types and oversized files before transmission", () => {
  assert.equal(validateMediaUpload({ name: "hero.jpg", size: 1024, type: "image/jpeg" }), null);
  assert.equal(validateMediaUpload({ name: "hero.png", size: 1024, type: "image/png" }), null);
  assert.equal(validateMediaUpload({ name: "hero.webp", size: 1024, type: "image/webp" }), null);
  assert.match(validateMediaUpload({ name: "hero.svg", size: 1024, type: "image/svg+xml" }) || "", /JPEG/);
  assert.match(validateMediaUpload({ name: "hero.jpg", size: MAX_MEDIA_UPLOAD_BYTES + 1, type: "image/jpeg" }) || "", /5 MB/);
  assert.match(validateMediaUpload({ name: "hero.png.exe", size: 1024, type: "image/png" }) || "", /JPEG/);
});

test("browser media upload is same-origin and never knows the Railway host or a bearer token", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "api", "media.ts"), "utf8");
  const uploader = source.slice(source.indexOf("export async function uploadMediaAsset"));
  assert.match(uploader, /request\.open\("POST", "\/api\/bff\/upload"\)/);
  assert.match(uploader, /request\.upload\.onprogress/);
  assert.doesNotMatch(uploader, /railway\.app|Authorization|Bearer /i);
  assert.doesNotMatch(uploader, /localStorage|sessionStorage/);
});

test("instagram draft previews share the catalogue proxy mapping", () => {
  assert.equal(
    dashboardMediaUrl("/api/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/card"),
    "/api/bff/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/card",
  );
  assert.equal(
    dashboardMediaUrl("https://scontent.example.test/photo.jpg"),
    "https://scontent.example.test/photo.jpg",
  );
});

// The `/uploads` passthrough exists only for legacy image bytes. It must not become a
// general proxy for the API root, where health, metrics and other routes are mounted.
test("only a single safe legacy upload filename is proxied at the API root", () => {
  assert.equal(isLegacyUploadPath("GET", "uploads/1778199301283-400484640.webp"), true);
  assert.equal(isLegacyUploadPath("HEAD", "uploads/item.webp"), true);
  assert.equal(isLegacyUploadPath("POST", "uploads/item.webp"), false);
  assert.equal(isLegacyUploadPath("DELETE", "uploads/item.webp"), false);
  assert.equal(isLegacyUploadPath("GET", "uploads/nested/item.webp"), false);
  assert.equal(isLegacyUploadPath("GET", "uploads/../server.js"), false);
  assert.equal(isLegacyUploadPath("GET", "uploads/"), false);
  assert.equal(isLegacyUploadPath("GET", "metrics"), false);
  assert.equal(isLegacyUploadPath("GET", "health"), false);
  assert.equal(isLegacyUploadPath("GET", "products"), false);
});
