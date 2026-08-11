import assert from "node:assert/strict";
import test from "node:test";
import {
  colorEntryHex,
  colorEntryLabel,
  joinVariantLines,
  parseImageLine,
  parseVariantLines,
  sameEntry,
  splitCsvLines,
  uniqueVariantSizes,
} from "../src/features/products/product-form-utils";

test("product option helpers preserve Turkish labels and normalize comparisons", () => {
  assert.deepEqual(splitCsvLines("İndirim, Yaz\nYeni"), ["İndirim", "Yaz", "Yeni"]);
  assert.equal(sameEntry("İPEK", "ipek"), true);
  assert.equal(colorEntryLabel("Bakır (#b87333)"), "Bakır");
  assert.equal(colorEntryHex("Bakır (#b87333)"), "#b87333");
});

test("variant parser deduplicates identities and derives non-negative lifecycle state", () => {
  const variants = parseVariantLines([
    "Siyah | M | 3 | SKU-M",
    "siyah | m | 9 | DUPLICATE",
    "Ekru | L | -4 | SKU-L",
  ].join("\n"));

  assert.deepEqual(variants, [
    { color: "Siyah", size: "M", stock: 3, sku: "SKU-M", status: "active" },
    { color: "Ekru", size: "L", stock: 0, sku: "SKU-L", status: "out" },
  ]);
  assert.deepEqual(uniqueVariantSizes(variants), ["M", "L"]);
  assert.equal(joinVariantLines(variants), "Siyah | M | 3 | SKU-M\nEkru | L | 0 | SKU-L");
});

test("product image parser keeps optional color binding separate from the URL", () => {
  assert.deepEqual(parseImageLine("Siyah | /api/media/1/card"), {
    color: "Siyah",
    url: "/api/media/1/card",
  });
  assert.deepEqual(parseImageLine("/uploads/plain.webp"), {
    color: "",
    url: "/uploads/plain.webp",
  });
});
