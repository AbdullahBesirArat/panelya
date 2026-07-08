import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProductDraftKey,
  createEmptyProductForm,
  isProductFormEmpty,
  readProductFormDraft,
  writeProductFormDraft,
} from "../src/lib/product-form-draft";

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("quick product draft key is scoped per organization", () => {
  assert.notEqual(buildProductDraftKey("suvera"), buildProductDraftKey("panelya"));
  assert.match(buildProductDraftKey("suvera"), /:suvera$/);
});

test("empty quick product form is not persisted", () => {
  const storage = createMemoryStorage();
  const key = buildProductDraftKey("suvera");

  storage.setItem(key, JSON.stringify({ name: "Eski taslak" }));
  writeProductFormDraft(key, createEmptyProductForm(), storage);

  assert.equal(storage.getItem(key), null);
});

test("quick product draft survives reload and keeps product fields", () => {
  const storage = createMemoryStorage();
  const key = buildProductDraftKey("suvera");
  const form = {
    ...createEmptyProductForm(),
    name: "Keten Elbise",
    price: "1490",
    stock: "8",
    categoryId: "12",
    status: "active" as const,
    imagesText: "/uploads/keten.webp",
    tags: "yeni, yaz",
  };

  writeProductFormDraft(key, form, storage);

  assert.deepEqual(readProductFormDraft(key, storage), form);
});

test("invalid persisted status falls back to draft", () => {
  const storage = createMemoryStorage();
  const key = buildProductDraftKey("suvera");

  storage.setItem(key, JSON.stringify({ name: "Hatalı taslak", status: "published" }));
  const draft = readProductFormDraft(key, storage);

  assert.equal(draft?.name, "Hatalı taslak");
  assert.equal(draft?.status, "draft");
  assert.equal(isProductFormEmpty(createEmptyProductForm()), true);
});
