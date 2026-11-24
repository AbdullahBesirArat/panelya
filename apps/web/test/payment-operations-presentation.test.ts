import test from "node:test";
import assert from "node:assert/strict";
import { buildBankTransferPayload, canShowPaymentActions, duplicateSubmitGuard, evidenceLevelLabels, operatorEvidenceBadge, parseMoneyToKurus, paymentErrorMessage, paymentErrorMessages } from "../src/lib/payment-operations-presentation";
const now = Date.parse("2026-11-25T12:00:00Z");
const input = { amount: "100,5", reference: " bank-1 ", receivedAt: "2026-11-24T12:00:00Z", level: "operator_recorded" as const, note: "Operatör gerekçe notu" };
test("money uses integer kuruş, accepts comma/dot and rejects malformed or nonpositive values", () => {
  for (const [value, expected] of [["0,01", "1"], ["100.50", "10050"], [" 00100 ", "10000"], ["999999999999.99", "99999999999999"]]) assert.equal(parseMoneyToKurus(value), BigInt(expected));
  for (const value of ["", " ", "0", "0.00", "-1", "+1", "1.234", "1,2.3", "1e3", "Infinity", "NaN", ".5", "1.", "1 000", "1,000", "１２", "1000000000000.00", "999999999999999999999.99"]) assert.throws(() => parseMoneyToKurus(value), value);
});
test("payload normalizes amount, locks currency, trims reference and emits ISO", () => {
  assert.deepEqual(buildBankTransferPayload(input, "TRY", now), { amount: "100.50", currency: "TRY", reference: "bank-1", receivedAt: "2026-11-24T12:00:00.000Z", level: "operator_recorded", note: "Operatör gerekçe notu" });
  assert.equal(buildBankTransferPayload({ ...input, amount: "100" }, "EUR", now).amount, "100.00");
});
test("payload rejects future/invalid dates, references and justification boundaries", () => {
  for (const receivedAt of ["", "bad", "2026-11-26T12:00:00Z"]) assert.throws(() => buildBankTransferPayload({ ...input, receivedAt }, "TRY", now));
  for (const reference of ["", "  ", "a".repeat(201)]) assert.throws(() => buildBankTransferPayload({ ...input, reference }, "TRY", now));
  assert.doesNotThrow(() => buildBankTransferPayload({ ...input, reference: "a".repeat(200) }, "TRY", now));
  for (const level of ["operator_recorded", "operator_asserted_verified"] as const) {
    assert.throws(() => buildBankTransferPayload({ ...input, level, note: "123456789" }, "TRY", now));
    assert.doesNotThrow(() => buildBankTransferPayload({ ...input, level, note: "a".repeat(2000) }, "TRY", now));
  }
  assert.doesNotThrow(() => buildBankTransferPayload({ ...input, level: "customer_claim", note: "" }, "TRY", now));
  assert.throws(() => buildBankTransferPayload({ ...input, level: "operator_asserted_verified", note: "" }, "TRY", now));
  assert.throws(() => buildBankTransferPayload({ ...input, note: "a".repeat(2001) }, "TRY", now));
  assert.throws(() => buildBankTransferPayload(input, "", now));
});
test("every required server code and HTTP failure has Turkish copy", () => {
  const codes = ["PAYMENT_EVIDENCE_REQUIRED", "PAYMENT_EVIDENCE_AMOUNT_MISMATCH", "PAYMENT_EVIDENCE_CURRENCY_MISMATCH", "PAYMENT_EVIDENCE_JUSTIFICATION_REQUIRED", "CARD_PAYMENT_PROVIDER_CONFIRMATION_ONLY", "ORDER_PAYMENT_REQUIRED", "ORDER_VERSION_CONFLICT", "ORDER_TRANSITION_INVALID"];
  for (const code of codes) { assert.ok(paymentErrorMessages[code]); assert.equal(paymentErrorMessage({ code, status: 409 }), paymentErrorMessages[code]); assert.match(paymentErrorMessages[code], /[çğıöşüİÖÜ]/); }
  for (const status of [400, 403, 404, 409]) assert.equal(paymentErrorMessage({ status }), paymentErrorMessages[String(status)]);
  for (const error of [new TypeError("fetch failed"), { status: 502 }, null]) assert.match(paymentErrorMessage(error), /yeniden göndermeden önce listeyi yenileyin/);
});
test("bank and operator wording never claims verification", () => {
  for (const label of [...Object.values(evidenceLevelLabels), operatorEvidenceBadge]) assert.doesNotMatch(label, /doğrulandı|verified/i);
  assert.equal(evidenceLevelLabels.customer_claim, "Müşteri beyanı (sayılmaz)");
});
test("payment actions only belong to managers and IBAN orders", () => {
  for (const role of ["super_admin", "owner", "admin"]) { assert.equal(canShowPaymentActions(role, { payment_method: "iban" }), true); assert.equal(canShowPaymentActions(role, { payment_method: "card" }), false); }
  for (const role of ["member", "viewer", "", "unknown"]) assert.equal(canShowPaymentActions(role, { payment_method: "iban" }), false);
  assert.equal(canShowPaymentActions("owner", null), false);
});
test("guard acquires synchronously and releases for a later deliberate attempt", () => {
  const guard = duplicateSubmitGuard(); assert.equal(guard.enter("save"), true); assert.equal(guard.enter("save"), false); assert.equal(guard.enter("other"), true); guard.leave("save"); assert.equal(guard.enter("save"), true);
});
test("every counted bank level needs a justification at the source and amounts have an upper bound", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const input = { amount: "100.00", reference: "REF-1", receivedAt: "2026-11-25T11:00:00Z", level: "operator_recorded" as const, note: "" };
  assert.throws(() => buildBankTransferPayload(input, "TRY", now), /Gerekçe/);
  assert.throws(() => buildBankTransferPayload({ ...input, note: "123456789" }, "TRY", now), /Gerekçe/);
  assert.doesNotThrow(() => buildBankTransferPayload({ ...input, note: "1234567890" }, "TRY", now));
  assert.doesNotThrow(() => buildBankTransferPayload({ ...input, level: "customer_claim" as const }, "TRY", now));
  assert.throws(() => parseMoneyToKurus("1000000000000.00"), /üst sınır/);
  assert.doesNotThrow(() => parseMoneyToKurus("999999999999.99"));
});
