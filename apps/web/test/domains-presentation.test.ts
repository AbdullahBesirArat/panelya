import test from "node:test";
import assert from "node:assert/strict";

import {
  canRelease, canSetCanonical, challengeAvailability, domainErrorMessage,
  domainStatusLabel, domainStatusTone, sslIsManagedAndActive, sslStatusLabel,
  sslStatusTone, verificationHint,
} from "../src/features/domains/presentation";
import type { DomainStatus, SslStatus } from "../src/lib/api/domains";

const ALL_STATUSES: DomainStatus[] = [
  "pending_verification", "verified", "provisioning", "active", "failed", "disabled", "released",
];

test("every domain status has a label and a tone", () => {
  for (const status of ALL_STATUSES) {
    assert.ok(domainStatusLabel(status).length > 0, `${status} needs a label`);
    assert.ok(["mint", "sun", "coral", "leaf"].includes(domainStatusTone(status)));
  }
  assert.equal(domainStatusTone("active"), "mint");
  assert.equal(domainStatusTone("pending_verification"), "sun");
  assert.equal(domainStatusTone("failed"), "coral");
});

test("an unmanaged certificate is never presented as active", () => {
  assert.equal(sslStatusLabel("not_configured"), "Yapılandırılmamış");
  assert.notEqual(sslStatusLabel("not_configured"), sslStatusLabel("active"));
  assert.equal(sslStatusTone("not_configured"), "leaf");
  // The one helper the UI uses to decide "is there a real, working certificate".
  assert.equal(sslIsManagedAndActive("not_configured", false), false);
  assert.equal(sslIsManagedAndActive("active", false), false, "an unconfigured provider cannot report a live certificate");
  assert.equal(sslIsManagedAndActive("provisioning", true), false);
  assert.equal(sslIsManagedAndActive("active", true), true);
});

test("every SSL state is labelled distinctly", () => {
  const statuses: SslStatus[] = ["pending", "provisioning", "active", "failed", "not_configured"];
  const labels = statuses.map(sslStatusLabel);
  assert.equal(new Set(labels).size, labels.length, "no two SSL states may read the same");
});

test("the raw challenge is only offered while it exists in this session", () => {
  // Freshly created/regenerated: the value is in memory and can be shown.
  assert.equal(challengeAvailability("pending_verification", true), "available");
  // After a reload it is gone for good, so the UI must offer regeneration instead of
  // pretending it can recover it from the stored hash.
  assert.equal(challengeAvailability("pending_verification", false), "regenerate_required");
  assert.equal(challengeAvailability("failed", false), "regenerate_required");
  // A verified/active domain does not need one at all.
  for (const status of ["verified", "provisioning", "active", "disabled", "released"] as DomainStatus[]) {
    assert.equal(challengeAvailability(status, false), "not_needed", `${status} needs no challenge`);
  }
});

test("canonical and release actions follow the backend lifecycle", () => {
  assert.equal(canSetCanonical("active", false), true);
  assert.equal(canSetCanonical("active", true), false, "the current canonical is not offered again");
  for (const status of ["pending_verification", "verified", "provisioning", "failed", "disabled"] as DomainStatus[]) {
    assert.equal(canSetCanonical(status, false), false, `${status} may not be canonical`);
  }
  // An active domain must be disabled before it can be released.
  assert.equal(canRelease("active"), false);
  assert.equal(canRelease("released"), false);
  assert.equal(canRelease("disabled"), true);
  assert.equal(canRelease("pending_verification"), true);
});

test("backend machine codes map to actionable Turkish guidance", () => {
  const codes = [
    "DOMAIN_SCHEME_NOT_ALLOWED", "DOMAIN_PORT_NOT_ALLOWED", "DOMAIN_IP_NOT_ALLOWED",
    "DOMAIN_RESERVED_PLATFORM", "DOMAIN_ALREADY_CLAIMED", "DOMAIN_NOT_VERIFIED",
    "PLAN_LIMIT_REACHED", "REASON_REQUIRED",
  ];
  for (const code of codes) {
    const message = domainErrorMessage(code, "sunucu mesaji");
    assert.ok(message.length > 0);
    assert.notEqual(message, "sunucu mesaji", `${code} must have its own guidance`);
  }
  // An unknown code falls through to the server's own message rather than being swallowed.
  assert.equal(domainErrorMessage("SOMETHING_NEW", "sunucu mesaji"), "sunucu mesaji");
  assert.equal(domainErrorMessage(null, "sunucu mesaji"), "sunucu mesaji");
  assert.equal(domainErrorMessage(null, ""), "İşlem tamamlanamadı.");
});

test("a failed DNS check explains what to do next", () => {
  assert.match(verificationHint("TXT_RECORD_NOT_FOUND"), /yayılma|görünmüyor/i);
  assert.match(verificationHint("DNS_TIMEOUT"), /zaman aşımı/i);
  assert.match(verificationHint("CHALLENGE_EXPIRED"), /süresi doldu/i);
  assert.ok(verificationHint("SOMETHING_ELSE").length > 0, "an unknown code still gets guidance");
  assert.equal(verificationHint(null), "", "no error means no hint");
});
