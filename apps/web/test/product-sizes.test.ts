import assert from "node:assert/strict";
import test from "node:test";

import { isPresetSize, mergeSizeOptions, normalizeCustomSize } from "../src/lib/product-sizes";

const PRESETS = ["Standart", "XS", "S", "M", "L", "XL", "XXL", "3XL"];

test("normalizeCustomSize boslugu temizler ve ic bosluklari tekilleştirir", () => {
  assert.equal(normalizeCustomSize("  1-2   Yaş  "), "1-2 Yaş");
  assert.equal(normalizeCustomSize("4XL"), "4XL");
});

test("normalizeCustomSize bos degeri bos dondurur", () => {
  assert.equal(normalizeCustomSize("   "), "");
  assert.equal(normalizeCustomSize(""), "");
});

test("normalizeCustomSize 24 karakterle sinirlar", () => {
  const long = "A".repeat(40);
  assert.equal(normalizeCustomSize(long).length, 24);
});

test("normalizeCustomSize kullanici formatini korur (turkce/yas ifadeleri)", () => {
  assert.equal(normalizeCustomSize("Büyük Beden"), "Büyük Beden");
  assert.equal(normalizeCustomSize("38-40"), "38-40");
  assert.equal(normalizeCustomSize("Standart Plus"), "Standart Plus");
});

test("mergeSizeOptions preset olmayan ozel bedenleri sona ekler", () => {
  const merged = mergeSizeOptions(PRESETS, ["62", "4XL", "1-2 Yaş"]);
  assert.deepEqual(merged.slice(PRESETS.length), ["62", "4XL", "1-2 Yaş"]);
});

test("mergeSizeOptions preset ile cakisan ozel bedeni eklemez (case-insensitive)", () => {
  const merged = mergeSizeOptions(PRESETS, ["xl", "XXL", "m"]);
  assert.deepEqual(merged, PRESETS); // hepsi zaten preset -> yeni eklenmez
});

test("mergeSizeOptions ozel bedenler arasindaki duplicate'i tekilleştirir", () => {
  const merged = mergeSizeOptions(PRESETS, ["4xl", "4XL", " 4xl "]);
  assert.deepEqual(merged.slice(PRESETS.length), ["4xl"]);
});

test("mergeSizeOptions bos/gecersiz degerleri atlar", () => {
  const merged = mergeSizeOptions(PRESETS, ["", "   ", "62"]);
  assert.deepEqual(merged.slice(PRESETS.length), ["62"]);
});

test("mergeSizeOptions custom null/undefined ile preset'i aynen dondurur", () => {
  assert.deepEqual(mergeSizeOptions(PRESETS, null), PRESETS);
  assert.deepEqual(mergeSizeOptions(PRESETS, undefined), PRESETS);
});

test("isPresetSize varsayilan bedeni tanir (case-insensitive)", () => {
  assert.equal(isPresetSize(PRESETS, "xl"), true);
  assert.equal(isPresetSize(PRESETS, "4XL"), false);
  assert.equal(isPresetSize(PRESETS, "1-2 Yaş"), false);
});
