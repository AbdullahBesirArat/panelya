export const PLATFORM_NAME = "Panelya";
export const PLATFORM_PRODUCT_NAME = "Panelya Operations";

const legacyDisplayNames: Record<string, string> = {
  "Maveran Demo": "Maveran",
  "Maveran Demo Owner": "Maveran Owner",
};

export function displayBrandName(value: string | null | undefined) {
  if (!value) return "";
  return legacyDisplayNames[value] || value;
}
