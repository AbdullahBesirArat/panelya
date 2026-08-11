import type {
  PlanChangePreview, SubscriptionInvoice, SubscriptionStatus, UsageWarning,
} from "@/lib/api/subscription";

// Pure presentation helpers, kept out of the component so they can be unit-tested without
// rendering. Nothing here decides policy — it only describes what the backend reported.

export type BannerTone = "info" | "warning" | "danger" | "neutral";

export type LifecycleBanner = {
  tone: BannerTone;
  title: string;
  body: string;
  /** Deadline the tenant should act by, when the backend gave one. */
  deadline: string | null;
};

const NEVER_LOSE_DATA = "Verileriniz saklanmaya devam ediyor; hiçbir ürün, sipariş veya müşteri kaydı silinmez.";

export function lifecycleBanner(subscription: {
  status: SubscriptionStatus;
  trial_end: string | null;
  grace_until: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  suspension_reason: string | null;
} | null): LifecycleBanner | null {
  if (!subscription) return null;

  switch (subscription.status) {
    case "trialing":
      return {
        tone: "info",
        title: "Deneme sürümü",
        body: "Deneme süreniz devam ediyor. Bir plan seçtiğinizde kesintisiz devam edersiniz.",
        deadline: subscription.trial_end,
      };
    case "past_due":
      return {
        tone: "warning",
        title: "Ödeme alınamadı",
        body: `Son ödemeniz tamamlanamadı. Mağazanız çalışmaya devam ediyor. ${NEVER_LOSE_DATA}`,
        deadline: null,
      };
    case "grace_period":
      return {
        tone: "warning",
        title: "Ek süre tanındı",
        body: `Ödeme tamamlanmazsa erişiminiz sınırlanacak. ${NEVER_LOSE_DATA}`,
        deadline: subscription.grace_until,
      };
    case "suspended":
      return {
        tone: "danger",
        title: "Abonelik askıya alındı",
        // Explicitly tells the tenant their data is intact: suspension is read-only, not deletion.
        body: `Yeni kayıt oluşturma durduruldu, mevcut verileriniz olduğu gibi duruyor. ${NEVER_LOSE_DATA} Ödemeyi tamamladığınızda erişim geri açılır.`,
        deadline: null,
      };
    case "cancelled":
      return {
        tone: "neutral",
        title: "Abonelik iptal edildi",
        body: `Mağazanız salt okunur durumda. ${NEVER_LOSE_DATA} Yeniden başlatarak devam edebilirsiniz.`,
        deadline: null,
      };
    case "expired":
      return {
        tone: "neutral",
        title: "Deneme süresi doldu",
        body: `Mağazanız salt okunur durumda. ${NEVER_LOSE_DATA} Bir plan seçerek devam edebilirsiniz.`,
        deadline: null,
      };
    case "active":
      return subscription.cancel_at_period_end
        ? {
          tone: "warning",
          title: "Dönem sonunda iptal edilecek",
          body: "Aboneliğiniz mevcut dönem sonunda sona erecek. Vazgeçmek için devam ettirebilirsiniz.",
          deadline: subscription.current_period_end,
        }
        : null;
    default:
      return null;
  }
}

// A limit of 0 means "no ceiling configured" everywhere in this platform (plan_limits and
// plan_versions both use 0 that way), so it must render as unlimited rather than as a
// limit of zero that is always exceeded.
export function isUnlimited(limit: number) {
  return !Number.isFinite(limit) || Number(limit) <= 0;
}

export function usagePercent(used: number, limit: number) {
  if (isUnlimited(limit)) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export type UsageRowView = {
  resource: string;
  label: string;
  used: number;
  limit: number;
  unlimited: boolean;
  percent: number;
  tone: "mint" | "sun" | "coral";
  state: "ok" | "warning" | "at_limit";
};

const RESOURCE_LABELS: Record<string, string> = {
  products: "Ürünler",
  orders_month: "Aylık sipariş",
  members: "Ekip üyeleri",
  storage_mb: "Depolama (MB)",
  collections: "Koleksiyonlar",
  blog_posts: "Blog yazıları",
};

export function usageRows(warnings: UsageWarning[]): UsageRowView[] {
  return warnings.map((warning) => {
    const unlimited = isUnlimited(warning.limit);
    const state = warning.atLimit ? "at_limit" : warning.warning ? "warning" : "ok";
    return {
      resource: warning.resource,
      label: RESOURCE_LABELS[warning.resource] || warning.resource,
      used: warning.used,
      limit: warning.limit,
      unlimited,
      percent: usagePercent(warning.used, warning.limit),
      tone: state === "at_limit" ? "coral" : state === "warning" ? "sun" : "mint",
      state,
    };
  });
}

// The backend decides whether an over-limit downgrade is blocked or scheduled to period
// end; this only reports which of those the backend said, and never invents a third rule.
export function downgradeOutcome(preview: PlanChangePreview | null, applied: boolean | null) {
  if (!preview) return null;
  if (!preview.exceeded) {
    return { kind: "immediate" as const, message: "Plan değişikliği hemen uygulanabilir." };
  }
  if (applied === false) {
    return {
      kind: "scheduled" as const,
      message: "Limit aşımı olduğu için değişiklik dönem sonunda uygulanacak. Hiçbir veriniz silinmez.",
    };
  }
  return {
    kind: "requires_action" as const,
    message: "Hedef planın limitleri mevcut kullanımınızın altında. Onaylarsanız değişiklik dönem sonuna planlanır; veri silinmez.",
  };
}

const MONEY = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(amount: string | number, currency: string) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `— ${currency}`;
  return `${MONEY.format(value)} ${currency}`;
}

export function invoiceTone(status: SubscriptionInvoice["status"]): "mint" | "sun" | "coral" | "leaf" {
  if (status === "paid") return "mint";
  if (status === "open") return "sun";
  if (status === "void" || status === "uncollectible") return "coral";
  return "leaf";
}

const INVOICE_LABELS: Record<SubscriptionInvoice["status"], string> = {
  draft: "Taslak",
  open: "Ödeme bekliyor",
  paid: "Ödendi",
  void: "İptal",
  uncollectible: "Tahsil edilemedi",
};

export function invoiceLabel(status: SubscriptionInvoice["status"]) {
  return INVOICE_LABELS[status] || status;
}

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Deneme",
  active: "Aktif",
  past_due: "Ödeme gecikti",
  grace_period: "Ek süre",
  suspended: "Askıda",
  cancelled: "İptal edildi",
  expired: "Süresi doldu",
};

export function statusLabel(status: SubscriptionStatus) {
  return STATUS_LABELS[status] || status;
}

export function statusTone(status: SubscriptionStatus): "mint" | "sun" | "coral" | "leaf" {
  if (status === "active") return "mint";
  if (status === "trialing") return "leaf";
  if (status === "past_due" || status === "grace_period") return "sun";
  return "coral";
}

export function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("tr-TR", { year: "numeric", month: "short", day: "numeric" });
}
