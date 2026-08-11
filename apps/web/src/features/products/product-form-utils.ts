import type { ProductVariant } from "@/lib/api/types";

export function splitCsvLines(value: string) {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinLines(values: string[] | null | undefined) {
  return Array.isArray(values) ? values.filter(Boolean).join("\n") : "";
}

export function splitImageLines(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseImageLine(line: string) {
  const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { color: parts[0], url: parts[parts.length - 1] };
  }
  return { color: "", url: line.trim() };
}

export function colorEntryLabel(value: string) {
  return value.replace(/#(?:[0-9a-f]{3}){1,2}\b/i, "").replace(/[()]/g, "").trim() || value;
}

export function colorEntryHex(value: string) {
  return value.match(/#(?:[0-9a-f]{3}){1,2}\b/i)?.[0] || "";
}

export function sameEntry(left: string, right: string) {
  return left.toLocaleLowerCase("tr-TR") === right.toLocaleLowerCase("tr-TR");
}

export function parseVariantLines(value: string): ProductVariant[] {
  const variants = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [color = "", size = "", stock = "0", sku = ""] = line.split("|").map((part) => part.trim());
      const normalizedStock = Math.max(0, Math.floor(Number(stock) || 0));
      return {
        color,
        size,
        stock: normalizedStock,
        sku,
        status: (normalizedStock > 0 ? "active" : "out") as ProductVariant["status"],
      };
    })
    .filter((variant) => variant.color || variant.size);

  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = `${variant.color.toLocaleLowerCase("tr-TR")}::${variant.size.toLocaleLowerCase("tr-TR")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function joinVariantLines(variants: ProductVariant[] | null | undefined) {
  if (!Array.isArray(variants)) return "";
  return variants
    .map((variant) => [variant.color || "", variant.size || "", String(variant.stock ?? 0), variant.sku || ""].join(" | "))
    .join("\n");
}

export function uniqueVariantSizes(variants: ProductVariant[]) {
  return Array.from(new Set(variants.map((variant) => variant.size).filter(Boolean)));
}
