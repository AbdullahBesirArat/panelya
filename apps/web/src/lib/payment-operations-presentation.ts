import type { BankTransferPayload, EvidenceLevel } from "./api/payment-operations";
export const paymentErrorMessages: Record<string, string> = {
  PAYMENT_EVIDENCE_REQUIRED: "Ödeme için sayılan bir kanıt kaydı gerekli.",
  PAYMENT_EVIDENCE_AMOUNT_MISMATCH: "Kanıt tutarı sipariş tutarıyla eşleşmiyor.",
  PAYMENT_EVIDENCE_CURRENCY_MISMATCH: "Kanıt para birimi siparişle eşleşmiyor.",
  PAYMENT_EVIDENCE_JUSTIFICATION_REQUIRED: "Kayıtta operatör gerekçesi yok. Kanıtlar sonradan değiştirilemez; sistem yöneticisiyle iletişime geçin.",
  CARD_PAYMENT_PROVIDER_CONFIRMATION_ONLY: "Kart ödemesini yalnızca sağlayıcı onaylayabilir.",
  ORDER_PAYMENT_REQUIRED: "Önce sipariş ödemesi tamamlanmalı.",
  ORDER_VERSION_CONFLICT: "Sipariş değişti. Listeyi yenileyip tekrar kontrol edin.",
  ORDER_TRANSITION_INVALID: "Siparişin mevcut durumu bu geçişe uygun değil.",
  "400": "Alanları kontrol edin; girilen bilgiler geçersiz.",
  "403": "Ödeme işlemlerine erişim yetkiniz yok.",
  "404": "Sipariş veya vaka bulunamadı.",
  "409": "İşlem mevcut kayıtlarla çakışıyor. Listeyi yenileyin.",
  network: "Kayıt durumu bilinmiyor; yeniden göndermeden önce listeyi yenileyin.",
};
export function paymentErrorMessage(error: unknown): string {
  const e = error as { code?: string; status?: number } | null;
  if (!e?.status || e.status >= 500) return paymentErrorMessages.network;
  return paymentErrorMessages[e.code || ""] || paymentErrorMessages[String(e.status)] || "İşlem tamamlanamadı. Listeyi yenileyin.";
}
export const evidenceLevelLabels: Record<EvidenceLevel, string> = {
  customer_claim: "Müşteri beyanı (sayılmaz)",
  operator_recorded: "Operatör kaydı",
  operator_asserted_verified: "Operatör banka paneline baktığını beyan ediyor",
};
export const operatorEvidenceBadge = "Operatör beyanı — banka doğrulaması değil";
export const priorityLabels = { none: "Öncelik yok", medium: "Orta", high: "Yüksek", critical: "Kritik" };
export const caseTypeLabels: Record<string, string> = { bank_transfer_underpaid: "Eksik ödeme", bank_transfer_overpaid: "Fazla ödeme", bank_transfer_multiple: "Birden fazla ödeme", bank_transfer_conflict: "Referans çakışması", bank_transfer_late: "Geç ödeme", provider_amount_mismatch: "Sağlayıcı tutar farkı", provider_duplicate_payment: "Çift tahsilat şüphesi", paid_on_cancelled_order: "İptal siparişe ödeme" };
export function parseMoneyToKurus(value: string): bigint {
  const text = value.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) throw new Error("Tutar pozitif ve en fazla iki ondalık basamaklı olmalı.");
  const [whole, fraction = ""] = text.replace(",", ".").split(".");
  const result = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (result <= BigInt(0)) throw new Error("Tutar sıfırdan büyük olmalı.");
  if (result >= BigInt("100000000000000")) throw new Error("Tutar izin verilen üst sınırı aşıyor.");
  return result;
}
export function buildBankTransferPayload(input: { amount: string; reference: string; receivedAt: string; level: EvidenceLevel; note: string; intendsToApprove?: boolean }, orderCurrency: string, now = Date.now()): BankTransferPayload {
  const money = parseMoneyToKurus(input.amount);
  const reference = input.reference.trim();
  const note = input.note.trim();
  const date = new Date(input.receivedAt);
  if (!orderCurrency) throw new Error("Sipariş para birimi bulunamadı.");
  if (!Object.hasOwn(evidenceLevelLabels, input.level)) throw new Error("Geçerli bir güven seviyesi seçin.");
  if (!reference || reference.length > 200) throw new Error("Referans 1–200 karakter olmalı.");
  if (!Number.isFinite(date.getTime()) || date.getTime() > now) throw new Error("Geçerli, gelecekte olmayan bir tarih seçin.");
  if (note.length > 2000 || (input.level !== "customer_claim" && note.length < 10)) throw new Error("Gerekçe 10–2000 karakter olmalı.");
  return { amount: `${money / BigInt(100)}.${String(money % BigInt(100)).padStart(2, "0")}`, currency: orderCurrency, reference, receivedAt: date.toISOString(), level: input.level, ...(note ? { note } : {}) };
}
export function duplicateSubmitGuard() {
  const active = new Set<string>();
  return { enter(key: string) { if (active.has(key)) return false; active.add(key); return true; }, leave(key: string) { active.delete(key); } };
}
export function canShowPaymentActions(role: string, order: { payment_method?: string; paymentMethod?: string } | null) {
  return ["super_admin", "owner", "admin"].includes(role) && (order?.payment_method ?? order?.paymentMethod) === "iban";
}
