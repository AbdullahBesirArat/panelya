import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("operations sections stay feature-split with an accessible loading fallback", () => {
  const source = read("src/components/operations-content.tsx");
  assert.match(source, /dynamic\(/);
  assert.match(source, /const loading = \(\) => <SectionLoading \/>/);
  for (const section of ["products", "orders", "customers", "analytics", "theme", "imports", "security"]) {
    assert.match(source, new RegExp(`components/sections/${section}-section`));
  }
  assert.doesNotMatch(source, /^import \{ .*Section \} from "@\/components\/sections\//m);
});

test("large admin searches are debounced and stale requests use TanStack Query AbortSignal", () => {
  for (const file of ["products-section.tsx", "orders-section.tsx", "customers-section.tsx", "carts-section.tsx"]) {
    const source = read(`src/components/sections/${file}`);
    assert.match(source, /useDebouncedValue/);
    assert.match(source, /queryFn: \(\{ signal \}\)/);
  }
  for (const file of ["catalog.ts", "orders.ts", "customers.ts", "carts.ts"]) {
    const source = read(`src/lib/api/${file}`);
    assert.match(source, /signal\?: AbortSignal/);
    assert.match(source, /\{ signal \}/);
  }
});

test("large list requests remain server-bounded and tenant query keys are centralized", () => {
  for (const file of ["products-section.tsx", "orders-section.tsx", "customers-section.tsx"]) {
    const source = read(`src/components/sections/${file}`);
    assert.match(source, /limit: (50|100|200)/);
    assert.match(source, /queryKeys\./);
  }
  const content = read("src/components/operations-content.tsx");
  assert.doesNotMatch(content, /from "recharts"|from "qrcode"/);
});
