import test from "node:test";
import assert from "node:assert/strict";
import { serializeLoadedOperationalSettings } from "../src/lib/store-settings-payload";

function form(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null } as Pick<FormData, "get">;
}

test("profile-only form defaults cannot overwrite operational settings that were never loaded", () => {
  const payload = serializeLoadedOperationalSettings({}, form({
    contactEmail: "",
    whatsappPhone: "",
    shippingFee: "0",
    paymentProvider: "manual",
  }));
  assert.deepEqual(payload, {});
});

test("loaded contact values are preserved and intentional edits are serialized", () => {
  const loaded = { contactEmail: "suverabutik@gmail.com", whatsappPhone: "905462924044" };
  assert.deepEqual(serializeLoadedOperationalSettings(loaded, form(loaded)), loaded);

  assert.deepEqual(serializeLoadedOperationalSettings(loaded, form({
    contactEmail: "yeni@ornek.com",
    whatsappPhone: "905551112233",
  })), {
    contactEmail: "yeni@ornek.com",
    whatsappPhone: "905551112233",
  });
});

test("a loaded field can still be intentionally cleared", () => {
  assert.deepEqual(serializeLoadedOperationalSettings(
    { contactEmail: "suverabutik@gmail.com", whatsappPhone: "905462924044" },
    form({ contactEmail: "", whatsappPhone: "" }),
  ), { contactEmail: "", whatsappPhone: "" });
});

test("unloaded shipping, payment and shopping notes stay out of a profile save", () => {
  const payload = serializeLoadedOperationalSettings(
    { contactEmail: "suverabutik@gmail.com" },
    form({
      contactEmail: "suverabutik@gmail.com",
      shippingFee: "99",
      paymentProvider: "iyzico",
      shoppingPaymentEnabled: "on",
    }),
  );
  assert.deepEqual(payload, { contactEmail: "suverabutik@gmail.com" });
});

test("loaded operational settings keep existing validation-shaped values", () => {
  const payload = serializeLoadedOperationalSettings({
    shippingFee: 0,
    freeShippingThreshold: 0,
    paymentProvider: "manual",
    paymentEnabled: true,
    orderEmailEnabled: true,
  }, form({
    shippingFee: "79.9",
    freeShippingThreshold: "600",
    paymentProvider: "iyzico",
    paymentEnabled: "on",
    orderEmailEnabled: "on",
  }));
  assert.deepEqual(payload, {
    shippingFee: 79.9,
    freeShippingThreshold: 600,
    paymentProvider: "iyzico",
    paymentEnabled: true,
    orderEmailEnabled: true,
  });
});
