export const PLATFORM_NAME = "Panelya";
export const PLATFORM_PRODUCT_NAME = "Panelya Operations";

const legacyDisplayNames: Record<string, string> = {
  Maveran: PLATFORM_NAME,
  "Maveran Demo": "Mavera",
  "Maveran Demo Owner": "Mavera Owner",
};

export function displayBrandName(value: string | null | undefined) {
  if (!value) return "";
  return legacyDisplayNames[value] || value;
}
