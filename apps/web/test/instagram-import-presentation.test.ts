import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ApiError } from "../src/lib/api/types";
import {
  dashboardMediaUrl, instagramDraftErrorMessage, instagramImportErrorMessage,
} from "../src/lib/api/instagram-import";

test("Instagram draft media stays on the dashboard same-origin BFF", () => {
  assert.equal(dashboardMediaUrl("/api/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/card"), "/api/bff/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/card");
});

test("Products contains an owner/admin Instagram + AI tab and price review guard", () => {
  const products = fs.readFileSync(path.join(process.cwd(), "src/components/sections/products-section.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(process.cwd(), "src/features/instagram-import/instagram-import-panel.tsx"), "utf8");
  const editor = fs.readFileSync(path.join(process.cwd(), "src/features/instagram-import/instagram-draft-editor.tsx"), "utf8");
  assert.match(products, /Instagram \+ AI/);
  assert.match(products, /tab\.key !== "instagram" \|\| canManageCatalog/);
  assert.match(panel, /target\.origin !== "https:\/\/www\.instagram\.com"/);
  assert.match(editor, /Number\(form\.price\) > 0/);
  assert.match(editor, /Fiyat doğrulanmadan ürün oluşturulamaz/);
});

test("client API only targets the same-origin BFF through authenticatedRequest", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/lib/api/instagram-import.ts"), "utf8");
  assert.doesNotMatch(api, /railway\.app|https:\/\/api\./i);
  assert.match(api, /authenticatedRequest/);
  assert.doesNotMatch(api, /access_token|client_secret|OPENAI_API_KEY/);
});

test("provider configuration errors remain actionable without exposing secrets", () => {
  assert.equal(
    instagramImportErrorMessage(new ApiError("generic", 503, null, "INSTAGRAM_NOT_CONFIGURED")),
    "Instagram bağlantısı production ortamında henüz yapılandırılmamış.",
  );
  assert.equal(
    instagramDraftErrorMessage("AI_CATALOG_NOT_CONFIGURED"),
    "AI katalog analizi production ortamında henüz yapılandırılmamış.",
  );
});
