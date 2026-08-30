import type { StoreSettings } from "@/lib/api/types";

type FormValueReader = Pick<FormData, "get">;

function hasLoadedSetting(settings: StoreSettings, key: keyof StoreSettings) {
  return Object.prototype.hasOwnProperty.call(settings, key);
}

function textValue(form: FormValueReader, name: string) {
  return String(form.get(name) || "").trim();
}

function numberValue(form: FormValueReader, name: string) {
  const number = Number(form.get(name));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function serializeLoadedOperationalSettings(
  settings: StoreSettings,
  form: FormValueReader,
): Partial<StoreSettings> {
  const payload: Partial<StoreSettings> = {};

  if (hasLoadedSetting(settings, "contactEmail")) payload.contactEmail = textValue(form, "contactEmail");
  if (hasLoadedSetting(settings, "supportPhone")) payload.supportPhone = textValue(form, "supportPhone");
  if (hasLoadedSetting(settings, "shippingFee")) payload.shippingFee = numberValue(form, "shippingFee");
  if (hasLoadedSetting(settings, "freeShippingThreshold")) payload.freeShippingThreshold = numberValue(form, "freeShippingThreshold");
  if (hasLoadedSetting(settings, "paymentProvider")) payload.paymentProvider = form.get("paymentProvider") === "iyzico" ? "iyzico" : "manual";
  if (hasLoadedSetting(settings, "paymentEnabled")) payload.paymentEnabled = form.get("paymentEnabled") === "on";
  if (hasLoadedSetting(settings, "orderEmailEnabled")) payload.orderEmailEnabled = form.get("orderEmailEnabled") === "on";
  if (hasLoadedSetting(settings, "whatsappPhone")) payload.whatsappPhone = textValue(form, "whatsappPhone");
  if (hasLoadedSetting(settings, "iban")) payload.iban = textValue(form, "iban");
  if (hasLoadedSetting(settings, "ibanHolderName")) payload.ibanHolderName = textValue(form, "ibanHolderName");
  if (hasLoadedSetting(settings, "bankName")) payload.bankName = textValue(form, "bankName");
  if (hasLoadedSetting(settings, "paymentNote")) payload.paymentNote = textValue(form, "paymentNote");

  if (hasLoadedSetting(settings, "shoppingNotes")) {
    payload.shoppingNotes = {
      freeShipping: {
        enabled: form.get("shoppingFreeShippingEnabled") === "on",
        description: textValue(form, "shoppingFreeShippingDescription"),
      },
      returns: {
        enabled: form.get("shoppingReturnsEnabled") === "on",
        title: textValue(form, "shoppingReturnsTitle"),
        description: textValue(form, "shoppingReturnsDescription"),
        days: numberValue(form, "shoppingReturnsDays"),
      },
      payment: {
        enabled: form.get("shoppingPaymentEnabled") === "on",
        title: textValue(form, "shoppingPaymentTitle"),
        description: textValue(form, "shoppingPaymentDescription"),
      },
    };
  }

  return payload;
}
