import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");

test("theme preview origin is tenant-resolved by the authenticated API", () => {
  const editor = fs.readFileSync(path.join(root, "src/components/sections/theme-section.tsx"), "utf8");
  const client = fs.readFileSync(path.join(root, "src/lib/api/themes.ts"), "utf8");
  assert.match(client, /authenticatedRequest<\{ origin: string \| null; source: string \}>\("\/themes\/preview-origin"\)/);
  assert.match(editor, /fetchThemePreviewOrigin/);
  assert.match(editor, /queryKeys\.theme\.previewOrigin\(organizationSlug\)/);
  assert.doesNotMatch(editor, /NEXT_PUBLIC_STOREFRONT_URL/);
  assert.doesNotMatch(editor, /fetchDomains/);
  assert.match(editor, /!storefrontOrigin \|\| previewMutation\.isPending/);
  assert.match(editor, /Ayarlar bölümünde geçerli bir Storefront Adresi/);
  const previewFlow = editor.slice(editor.indexOf("const previewMutation"), editor.indexOf("// Autosave"));
  assert.match(previewFlow, /createThemePreviewToken/);
  assert.match(previewFlow, /previewUrl\(storefrontOrigin, result\.token\)/);
  assert.doesNotMatch(previewFlow, /publishThemeDraft|publishMutation/);
});

test("owner settings manage the existing tenant storefront URL field", () => {
  const settings = fs.readFileSync(path.join(root, "src/components/sections/settings-section.tsx"), "utf8");
  const organizations = fs.readFileSync(path.join(root, "src/lib/api/organizations.ts"), "utf8");
  assert.match(settings, /Storefront Adresi/);
  assert.match(settings, /name="storefrontUrl"/);
  assert.match(settings, /summary\.organization\.storefront_url/);
  assert.match(settings, /Önizleme ve mağaza bağlantılarında kullanılacak ana storefront adresi/);
  assert.match(settings, /queryKeys\.theme\.previewOrigin\(organizationSlug\)/);
  assert.match(organizations, /storefrontUrl\?: string/);
  assert.doesNotMatch(settings, /railway\.app|Authorization:\s*["']Bearer/i);
});

test("profile-only saves preserve operational settings omitted by a stale summary", () => {
  const settings = fs.readFileSync(path.join(root, "src/components/sections/settings-section.tsx"), "utf8");
  assert.match(settings, /const hasStoredSetting = \(key: string\)/);
  assert.match(settings, /hasStoredSetting\("contactEmail"\) && contactEmail/);
  assert.match(settings, /hasStoredSetting\("whatsappPhone"\) && whatsappPhone/);
  assert.match(settings, /hasStoredSetting\("shoppingNotes"\)/);
  assert.match(settings, /brand: \{/);
  assert.match(settings, /serviceNotes: String\(form\.get\("serviceNotes"\)/);
});
