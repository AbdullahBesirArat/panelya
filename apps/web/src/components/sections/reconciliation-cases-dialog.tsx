"use client";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminDialog } from "@/components/ui/admin-dialog";
import { Button } from "@/components/ui/button";
import { fetchReconciliationCases, resolveReconciliationCase, type CaseStatus, type PaymentCase, type ResolvePayload } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { duplicateSubmitGuard, paymentErrorMessage } from "@/lib/payment-operations-presentation";
import { PaymentCaseRow, paymentInputClass } from "./order-payment-panel";
const statusLabels = { open: "Açık", resolved_accepted: "Kabul edilerek çözüldü", dismissed: "Kapatıldı", resolved_refunded: "İade kaydıyla çözüldü" };
export function ReconciliationCasesDialog({ organizationSlug, onClose, onOpenOrder }: { organizationSlug: string; onClose: () => void; onOpenOrder: (id: string) => void }) {
  const client = useQueryClient();
  const [openedAt] = useState(() => Date.now());
  const guard = useRef(duplicateSubmitGuard());
  const [status, setStatus] = useState<CaseStatus>("open");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<PaymentCase | null>(null);
  const [resolution, setResolution] = useState<ResolvePayload["resolution"]>("resolved_accepted");
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [evidenceType, setEvidenceType] = useState<NonNullable<ResolvePayload["evidenceType"]>>("documented_evidence");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const query = useQuery({ queryKey: queryKeys.paymentOperations.cases(organizationSlug, status, cursor), queryFn: () => fetchReconciliationCases(status, cursor), retry: false });
  const mutation = useMutation({ mutationFn: (payload: ResolvePayload) => resolveReconciliationCase(selected!.id, payload), retry: false });
  async function resolve() {
    if (!selected || uncertain || !guard.current.enter("resolve")) return;
    setError(""); setNotice("");
    try {
      if (note.trim().length < 10 || note.trim().length > 2000) { setError("Gerekçe 10–2000 karakter olmalı."); return; }
      if (resolution === "resolved_refunded" && !reference.trim()) { setError("İade kaydı için dış referans gerekli."); return; }
      await mutation.mutateAsync({ resolution, note: note.trim(), ...(resolution === "resolved_refunded" ? { externalReference: reference.trim(), evidenceType } : {}) });
      setNotice(resolution === "resolved_refunded" ? "İade kaydı operatör beyanıdır; sağlayıcıdan doğrulanmış değildir" : "Vaka çözümü kaydedildi.");
      setSelected(null); setNote(""); setReference("");
      await Promise.all([client.invalidateQueries({ queryKey: queryKeys.paymentOperations.all(organizationSlug) }), client.invalidateQueries({ queryKey: queryKeys.orders.detail(organizationSlug, selected.order_id) }), client.invalidateQueries({ queryKey: queryKeys.orders.all(organizationSlug) })]);
    } catch (e) { setError(paymentErrorMessage(e)); const s = (e as { status?: number }).status; if (!s || s >= 500) setUncertain(true); }
    finally { guard.current.leave("resolve"); }
  }
  return <AdminDialog title="Mutabakat vakaları" size="lg" onClose={() => { if (!mutation.isPending) onClose(); }}><div className="space-y-3">
    <label>Durum<select className={paymentInputClass} value={status} disabled={mutation.isPending} onChange={(e) => { setStatus(e.target.value as CaseStatus); setCursor(undefined); setSelected(null); }}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {query.isPending && <div aria-label="Vakalar yükleniyor" className="h-32 animate-pulse rounded-lg bg-zinc-100" />}
    {query.isError && <p role="alert" data-testid="payment-error">{paymentErrorMessage(query.error)}</p>}
    {!query.isError && query.data?.cases.length === 0 && <p className="text-sm text-zinc-600">Bu durumda vaka yok.</p>}
    {!query.isError && query.data?.cases.map((item) => <div key={item.id} className="space-y-2"><PaymentCaseRow item={item} /><p className="text-sm text-zinc-600">Yaş: {Math.max(0, Math.floor((openedAt - Date.parse(item.detected_at)) / 3600000))} saat · {new Date(item.detected_at).toLocaleString("tr-TR")}</p>{item.refundVerification === "operator_asserted_unverified" && <p className="text-sm">İade kaydı operatör beyanıdır; sağlayıcıdan doğrulanmış değildir</p>}<Button variant="ghost" disabled={mutation.isPending} onClick={() => { onClose(); onOpenOrder(item.order_id); }}>Siparişi aç</Button>{item.status === "open" && <Button variant="outline" disabled={mutation.isPending} onClick={() => { setSelected(item); setNote(""); setReference(""); setError(""); }}>Çözüm kaydı ekle</Button>}</div>)}
    {query.data?.nextCursor && <Button variant="outline" disabled={query.isFetching || mutation.isPending} onClick={() => { setCursor(query.data!.nextCursor!); setSelected(null); }}>Sonraki sayfa</Button>}{cursor && <Button variant="ghost" onClick={() => setCursor(undefined)}>İlk sayfa</Button>}
    {selected && <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void resolve(); }}><h3 className="font-semibold">Vaka çözümü</h3><label>Çözüm<select className={paymentInputClass} value={resolution} onChange={(e) => setResolution(e.target.value as ResolvePayload["resolution"])}>{Object.entries(statusLabels).filter(([v]) => v !== "open").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Gerekçe<textarea className={paymentInputClass} required minLength={10} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    {resolution === "resolved_refunded" && <><p className="text-sm text-zinc-600">İade kaydı operatör beyanıdır; sağlayıcıdan doğrulanmış değildir</p><label>Dış referans<input className={paymentInputClass} required value={reference} onChange={(e) => setReference(e.target.value)} /></label><label>Kanıt türü<select className={paymentInputClass} value={evidenceType} onChange={(e) => setEvidenceType(e.target.value as typeof evidenceType)}><option value="documented_evidence">Belgelenmiş kanıt</option><option value="bank_transfer_reference">Havale referansı</option><option value="provider_dashboard_reference">Sağlayıcı paneli referansı</option></select></label></>}
    <p className="text-sm text-zinc-600">Bu işlem yalnızca vaka çözümünü kaydeder.</p><Button type="submit" disabled={mutation.isPending || uncertain}>Çözümü kaydet</Button></form>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" data-testid="payment-error">{error}</p>}<Button data-testid="payment-retry" variant="outline" disabled={query.isFetching || mutation.isPending} onClick={async () => { const result = await query.refetch(); if (result.isSuccess) { setUncertain(false); setError(""); } }}>Listeyi yenile</Button>
  </div></AdminDialog>;
}
