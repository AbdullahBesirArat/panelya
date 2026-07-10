// Ozel beden (custom size) yardimcilari. Renklerdeki "Ozel Renk" mekanigiyle
// ayni mantik: kullanicinin girdigi beden normalize edilir ve varsayilan/onerilen
// bedenlerle case-insensitive olarak birlestirilir (duplicate olusmaz).

const MAX_CUSTOM_SIZE_LENGTH = 24;

// Bas/son bosluklari temizler, ic bosluklari tekilleştirir ve makul uzunlukta
// keser. Kullanici formatina yakin kalmak icin harf buyuk/kucukluğu korunur;
// duplicate kontrolu case-insensitive yapildigindan "4xl" ve "4XL" ayni sayilir.
export function normalizeCustomSize(raw: string): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_SIZE_LENGTH);
}

function sizeKey(value: string): string {
  return normalizeCustomSize(value).toLocaleLowerCase("tr-TR");
}

// Varsayilan preset bedenleri, magaza seviyesindeki ozel bedenlerle birlestirir.
// Preset'te (case-insensitive) zaten var olan veya birbirini tekrar eden ozel
// bedenler eklenmez; boylece oneri listesi temiz kalir.
export function mergeSizeOptions(
  presets: readonly string[],
  custom: readonly string[] | null | undefined,
): string[] {
  const seen = new Set(presets.map((size) => size.toLocaleLowerCase("tr-TR")));
  const extras: string[] = [];

  for (const raw of custom ?? []) {
    const size = normalizeCustomSize(raw);
    if (!size) continue;
    const key = size.toLocaleLowerCase("tr-TR");
    if (seen.has(key)) continue;
    seen.add(key);
    extras.push(size);
  }

  return [...presets, ...extras];
}

// Bir bedenin preset (varsayilan) mi yoksa ozel mi oldugunu belirler.
export function isPresetSize(presets: readonly string[], size: string): boolean {
  const key = sizeKey(size);
  return presets.some((preset) => preset.toLocaleLowerCase("tr-TR") === key);
}
