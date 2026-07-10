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
    categoryId: "12",
    status: "active" as const,
    imagesText: "/uploads/keten.webp",
    tags: "yeni, yaz",
  };

  writeProductFormDraft(key, form, storage);

  assert.deepEqual(readProductFormDraft(key, storage), form);
});

test("new quick product form defaults to active status", () => {
  const form = createEmptyProductForm();

  assert.equal(form.status, "active");
  assert.equal(isProductFormEmpty(form), true);
});

test("reset empty product form returns active status", () => {
  const resetForm = createEmptyProductForm();

  assert.equal(resetForm.status, "active");
  assert.equal(resetForm.name, "");
});

test("persisted draft status is preserved", () => {
  const storage = createMemoryStorage();
  const key = buildProductDraftKey("suvera");

  storage.setItem(key, JSON.stringify({ name: "Taslak ürün", status: "draft" }));
  const draft = readProductFormDraft(key, storage);

  assert.equal(draft?.name, "Taslak ürün");
  assert.equal(draft?.status, "draft");
});

test("legacy quick product draft stock and emoji fields are ignored", () => {
  const storage = createMemoryStorage();
  const key = buildProductDraftKey("suvera");

  storage.setItem(key, JSON.stringify({
    name: "Eski taslak",
    price: "1490",
    stock: "8",
    emoji: "legacy",
    status: "active",
  }));
  const draft = readProductFormDraft(key, storage);

  assert.equal(draft?.name, "Eski taslak");
  assert.equal(draft?.price, "1490");
  assert.equal(Object.prototype.hasOwnProperty.call(draft, "stock"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(draft, "emoji"), false);
});

test("invalid persisted status falls back to active", () => {
  const storage = createMemoryStorage();
  const key = buildProductDraftKey("suvera");

  storage.setItem(key, JSON.stringify({ name: "Hatalı taslak", status: "published" }));
  const draft = readProductFormDraft(key, storage);

  assert.equal(draft?.name, "Hatalı taslak");
  assert.equal(draft?.status, "active");
  assert.equal(isProductFormEmpty(createEmptyProductForm()), true);
});
