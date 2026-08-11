import type { DomainStatus, SslStatus } from "@/lib/api/domains";

// Pure presentation helpers so the domain UI can be unit-tested without rendering.
// Nothing here decides policy: it only describes what the backend reported.

const STATUS_LABELS: Record<DomainStatus, string> = {
  pending_verification: "Doğrulama bekliyor",
  verified: "Doğrulandı",
  provisioning: "Hazırlanıyor",
  active: "Yayında",
  failed: "Başarısız",
  disabled: "Devre dışı",
  released: "Bırakıldı",
};

export function domainStatusLabel(status: DomainStatus) {
  return STATUS_LABELS[status] || status;
}

export function domainStatusTone(status: DomainStatus): "mint" | "sun" | "coral" | "leaf" {
  if (status === "active") return "mint";
  if (status === "verified" || status === "provisioning") return "leaf";
  if (status === "pending_verification") return "sun";
  return "coral";
}

const SSL_LABELS: Record<SslStatus, string> = {
  pending: "Bekliyor",
  provisioning: "Hazırlanıyor",
  active: "Aktif",
  failed: "Başarısız",
  // Honest state: the platform is not managing this certificate. It must never read as
  // "active", because nothing was provisioned.
  not_configured: "Yapılandırılmamış",
};

export function sslStatusLabel(status: SslStatus) {
  return SSL_LABELS[status] || status;
}

export function sslStatusTone(status: SslStatus): "mint" | "sun" | "coral" | "leaf" {
  if (status === "active") return "mint";
  if (status === "provisioning" || status === "pending") return "sun";
  if (status === "failed") return "coral";
  return "leaf";
}

/**
 * True only when the platform actually manages a live certificate. The UI must never
 * present `not_configured` as a working certificate.
 */
export function sslIsManagedAndActive(status: SslStatus, providerConfigured: boolean) {
  return providerConfigured && status === "active";
}

// Backend machine codes -> Turkish guidance. The backend is the authority; this only makes
// its decision readable. An unknown code falls through to the server's own message.
const ERROR_MESSAGES: Record<string, string> = {
  DOMAIN_SCHEME_NOT_ALLOWED: "Yalnızca alan adını girin, http:// veya https:// eklemeyin.",
  DOMAIN_PATH_NOT_ALLOWED: "Alan adı bir yol (/) içeremez.",
  DOMAIN_QUERY_NOT_ALLOWED: "Alan adı sorgu parametresi içeremez.",
  DOMAIN_FRAGMENT_NOT_ALLOWED: "Alan adı # işareti içeremez.",
  DOMAIN_PORT_NOT_ALLOWED: "Alan adı port numarası içeremez.",
  DOMAIN_USERINFO_NOT_ALLOWED: "Alan adı kullanıcı bilgisi (@) içeremez.",
  DOMAIN_WILDCARD_NOT_ALLOWED: "Joker (*) alan adları desteklenmiyor.",
  DOMAIN_WHITESPACE: "Alan adı boşluk içeremez.",
  DOMAIN_IP_NOT_ALLOWED: "IP adresi alan adı olarak kullanılamaz.",
  DOMAIN_NOT_QUALIFIED: "Tam bir alan adı girin (örnek: magaza.example.com).",
  DOMAIN_EMPTY_LABEL: "Alan adında ardışık nokta olamaz.",
  DOMAIN_LABEL_HYPHEN: "Alan adı bölümleri tire ile başlayıp bitemez.",
  DOMAIN_LABEL_TOO_LONG: "Alan adı bölümü çok uzun.",
  DOMAIN_TOO_LONG: "Alan adı çok uzun.",
  DOMAIN_RESERVED_INTERNAL: "Bu alan adı dahili/ayrılmış olduğu için kullanılamaz.",
  DOMAIN_RESERVED_PLATFORM: "Bu alan adı platforma ait olduğu için eklenemez.",
  DOMAIN_ALREADY_CLAIMED: "Bu alan adı başka bir mağaza tarafından kullanılıyor.",
  DOMAIN_ALREADY_ADDED: "Bu alan adı zaten listenizde.",
  DOMAIN_NOT_VERIFIED: "Önce DNS doğrulamasını tamamlayın.",
  DOMAIN_NOT_ACTIVE: "Yalnızca yayındaki bir alan adı birincil yapılabilir.",
  DOMAIN_STILL_ACTIVE: "Önce alan adını devre dışı bırakın.",
  DOMAIN_CHALLENGE_EXPIRED: "Doğrulama kaydının süresi doldu, yeni bir kayıt oluşturun.",
  DOMAIN_CHALLENGE_MISSING: "Doğrulama kaydı yok, yeni bir kayıt oluşturun.",
  DOMAIN_ALREADY_ACTIVE: "Alan adı zaten yayında.",
  PLAN_LIMIT_REACHED: "Alan adı limitinize ulaştınız. Planınızı yükseltebilirsiniz.",
  REASON_REQUIRED: "Bu işlem için gerekçe zorunludur (en az 5 karakter).",
};

export function domainErrorMessage(code: string | null, fallback: string) {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback || "İşlem tamamlanamadı.";
}

// Why verification failed on the last check, in tenant-readable terms.
const CHECK_HINTS: Record<string, string> = {
  TXT_RECORD_NOT_FOUND: "TXT kaydı henüz görünmüyor. DNS yayılması birkaç dakika ile birkaç saat sürebilir.",
  DNS_TIMEOUT: "DNS sorgusu zaman aşımına uğradı. Biraz sonra tekrar deneyin.",
  DNS_LOOKUP_FAILED: "DNS sorgusu başarısız oldu. Kayıt adını ve değerini kontrol edin.",
  CHALLENGE_EXPIRED: "Doğrulama kaydının süresi doldu. Yeni bir kayıt oluşturun.",
};

export function verificationHint(errorCode: string | null) {
  if (!errorCode) return "";
  return CHECK_HINTS[errorCode] || "Doğrulama tamamlanamadı. DNS kaydını kontrol edin.";
}

/**
 * The raw challenge exists only in the create/regenerate response. After a reload it is
 * gone for good (the backend keeps only a hash), so the UI must offer regeneration rather
 * than pretending it can show the value again.
 */
export function challengeAvailability(status: DomainStatus, challengeInSession: boolean) {
  if (status !== "pending_verification" && status !== "failed") return "not_needed" as const;
  return challengeInSession ? ("available" as const) : ("regenerate_required" as const);
}

export function canSetCanonical(status: DomainStatus, isCanonical: boolean) {
  return status === "active" && !isCanonical;
}

export function canRelease(status: DomainStatus) {
  return status !== "active" && status !== "released";
}

export function formatDomainDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("tr-TR", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
