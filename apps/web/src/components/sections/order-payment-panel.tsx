"use client";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AdminDialog } from "@/components/ui/admin-dialog";
import { fetchPaymentEvidence, recordBankTransfer, transitionOrder, type ApiOrderDetail, type EvidenceLevel, type PaymentCase } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { buildBankTransferPayload, caseTypeLabels, duplicateSubmitGuard, evidenceLevelLabels, operatorEvidenceBadge, paymentErrorMessage, priorityLabels } from "@/lib/payment-operations-presentation";
export const paymentInputClass = "focus-ring w-full rounded-lg border border-line bg-white p-2 text-sm";
function localNowInput() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

export function PaymentCaseRow({ item }: { item: PaymentCase }) {
  return <div data-testid="payment-case" className="rounded-lg border border-line p-3 text-sm"><strong>{caseTypeLabels[item.case_type] || "Mutabakat incelemesi"}</strong> <Badge tone={item.priority === "critical" || item.priority === "high" ? "coral" : "sun"}>{priorityLabels[item.priority]}</Badge>{item.stockHeld && <p>Stok ayrılı tutuluyor; açık vaka çözülene kadar süre aşımı iptali yapılmaz.</p>}</div>;
}
export function OrderPaymentPanel({ order, organizationSlug, canManage }: { order: ApiOrderDetail; organizationSlug: string; canManage: boolean }) {
  const client = useQueryClient();
  const guard = useRef(duplicateSubmitGuard());
  const [form, setForm] = useState(() => ({ amount: "", reference: "", receivedAt: localNowInput(), level: "operator_recorded" as EvidenceLevel, note: "", intendsToApprove: false }));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const key = queryKeys.paymentOperations.evidence(organizationSlug, order.id);
  const query = useQuery({ queryKey: key, queryFn: () => fetchPaymentEvidence(order.id), enabled: canManage, retry: false });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: queryKeys.paymentOperations.all(organizationSlug) }), client.invalidateQueries({ queryKey: queryKeys.orders.detail(organizationSlug, order.id) }), client.invalidateQueries({ queryKey: queryKeys.orders.all(organizationSlug) })]); };
  const mutation = useMutation({ mutationFn: async (action: "save" | "approve") => {
    if (action === "approve") { await transitionOrder(order.id, { domain: "payment", status: "paid", version: order.version }); return "Ödeme onaylandı."; }
    const payload = buildBankTransferPayload(form, query.data?.totals.currency || "");
    const result = await recordBankTransfer(order.id, payload);
    setForm((current) => ({ ...current, reference: "" }));
    return result.replay ? "Bu kayıt zaten var" : result.evaluation.status === "conflict" ? "Çakışma vakası açıldı; kanıt eklenmedi" : "Kanıt kaydedildi.";
  }, retry: false });
  async function submit(action: "save" | "approve") {
    if (uncertain || !guard.current.enter("payment")) return;
    setError(""); setMessage("");
    if (action === "save") {
      try { buildBankTransferPayload(form, query.data?.totals.currency || ""); }
      catch (e) { setError(e instanceof Error ? e.message : "Alanları kontrol edin."); guard.current.leave("payment"); return; }
    }
    try {
      setMessage(await mutation.mutateAsync(action)); setConfirm(false); await refresh();
    } catch (e) {
      setConfirm(false);
      const status = (e as { status?: number }).status;
      setError(paymentErrorMessage(e)); if (!status || status >= 500) setUncertain(true);
    } finally { guard.current.leave("payment"); }
  }
  if (!canManage) return null;
  if (query.isPending) return <section data-testid="payment-panel" aria-label="Ödeme yükleniyor" className="h-40 animate-pulse rounded-lg bg-zinc-100" />;
  const retry = <Button data-testid="payment-retry" variant="outline" disabled={query.isFetching || mutation.isPending} onClick={async () => { const result = await query.refetch(); if (result.isSuccess) { setUncertain(false); setError(""); } }}>Listeyi yenile</Button>;
  if (query.isError || !query.data) return <section data-testid="payment-panel"><p data-testid="payment-error" role="alert">{paymentErrorMessage(query.error)}</p>{retry}</section>;
  const data = query.data;
  const bank = order.payment_method === "iban";
  const difference = !/^-?0+(?:\.0+)?$/.test(data.totals.difference);
  const canApproveTransition = Boolean(order.valid_transitions?.payment?.includes("paid"));
  return <section data-testid="payment-panel" className="space-y-3 rounded-lg border border-line p-4"><h3 className="font-bold">Ödeme kanıtları</h3>
    {data.stockHeld && <p data-testid="stock-held-notice" className="text-sm text-zinc-600">Stok ayrılı tutuluyor; açık vaka çözülene kadar süre aşımı iptali yapılmaz.</p>}
    {!bank && <p className="text-sm text-zinc-600">Kart ödemesi yalnızca sağlayıcı tarafından onaylanır.</p>}
    {data.cases.filter((item) => item.status === "open").map((item) => <PaymentCaseRow key={item.id} item={item} />)}
    <div data-testid="evidence-list" className="space-y-2">{!data.evidence.length && <p className="text-sm text-zinc-600">Henüz kanıt yok.</p>}{data.evidence.map((item) => <div data-testid="evidence-row" key={item.id} className="rounded-lg border border-line p-3 text-sm"><p>{item.amount} {item.currency} · …{item.referenceLast4}</p><Badge>{item.verification === "provider_verified" ? "Sağlayıcıdan doğrulandı" : item.verification === "customer_claim" ? evidenceLevelLabels.customer_claim : operatorEvidenceBadge}</Badge><p>{new Date(item.received_at).toLocaleString("tr-TR")}</p></div>)}</div>
    <div data-testid="payment-totals" className="text-sm"><p>Sipariş toplamı: {data.totals.orderTotal} {data.totals.currency}</p><p>Sayılan kayıt toplamı: {data.totals.counted} {data.totals.currency}</p><p>Müşteri beyanı: {data.totals.claimed} {data.totals.currency}</p><p data-testid="payment-difference" className={difference ? "font-semibold text-coral" : "text-zinc-600"}>Fark: {data.totals.difference} {data.totals.currency}{difference && " — Tutar farkı var; ödeme onaylanamaz."}</p></div>
    {bank && <><form data-testid="evidence-form" className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit("save"); }}><fieldset className="grid gap-3" disabled={mutation.isPending || uncertain}>
      <label>Tutar<input data-testid="evidence-amount" aria-invalid={Boolean(error)} aria-describedby={error ? "payment-error-text" : undefined} className={paymentInputClass} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
      <label>Para birimi<input className={paymentInputClass} readOnly value={data.totals.currency} /></label>
      <label>Banka referansı<input data-testid="evidence-reference" aria-invalid={Boolean(error)} aria-describedby={error ? "payment-error-text" : undefined} className={paymentInputClass} maxLength={200} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} required /></label>
      <label>Alınma tarihi<input data-testid="evidence-date" className={paymentInputClass} type="datetime-local" value={form.receivedAt} onChange={(e) => setForm({ ...form, receivedAt: e.target.value })} required /></label>
      <label>Güven seviyesi<select data-testid="evidence-level" className={paymentInputClass} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as EvidenceLevel })}>{Object.entries(evidenceLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p className="text-sm text-zinc-600">{operatorEvidenceBadge}</p>
      <label>Gerekçe<textarea data-testid="evidence-note" className={paymentInputClass} maxLength={2000} minLength={form.level !== "customer_claim" ? 10 : undefined} required={form.level !== "customer_claim"} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <label className="text-sm"><input type="checkbox" checked={form.intendsToApprove} onChange={(e) => setForm({ ...form, intendsToApprove: e.target.checked })} /> Bu kayıtla ödeme onayı vermeyi planlıyorum (en az 10 karakter gerekçe).</label>
      <Button data-testid="evidence-submit" disabled={mutation.isPending || uncertain || query.isFetching} type="submit">Kanıtı kaydet</Button>
    </fieldset></form><Button data-testid="payment-approve" disabled={!data.paymentApproval.allowed || !canApproveTransition || mutation.isPending || uncertain || query.isFetching} onClick={() => setConfirm(true)}>Ödemeyi onayla</Button>{!data.paymentApproval.allowed && <p className="text-sm text-zinc-600">{data.paymentApproval.blocker ? paymentErrorMessage({ code: data.paymentApproval.blocker, status: 409 }) : "Ödeme onayı koşulları sağlanmadı."}</p>}</>}
    {message && <p role="status" className="text-sm">{message}</p>}{error && <p id="payment-error-text" data-testid="payment-error" role="alert" className="text-sm text-coral">{error}</p>}{retry}
    {confirm && <AdminDialog title="Ödeme onayı" onClose={() => { if (!mutation.isPending) setConfirm(false); }}><p>Bu işlem bir operatör beyanına dayanır; banka tarafından doğrulanmış değildir.</p><Button data-testid="payment-approve-confirm" disabled={mutation.isPending || uncertain || query.isFetching || !data.paymentApproval.allowed} onClick={() => void submit("approve")}>Ödemeyi onayla</Button></AdminDialog>}
  </section>;
}
