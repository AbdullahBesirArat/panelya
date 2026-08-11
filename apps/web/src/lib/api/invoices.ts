import { authenticatedRequest } from "./core";

export type InvoiceStatus = "draft" | "processing" | "issued" | "cancelled" | "failed";
export type InvoiceDocument = { id: string; document_type: string; filename: string; content_type: string; byte_size: number; created_at: string };

export type ApiInvoice = {
  id: string;
  order_id: string;
  order_code: string;
  invoice_number: string | null;
  invoice_type: "sale" | "return" | "credit_note";
  status: InvoiceStatus;
  provider: string;
  provider_reference: string | null;
  net_total: number;
  tax_total: number;
  gross_total: number;
  currency: string;
  issued_at: string | null;
  created_at: string;
  snapshot?: {
    invoice?: {
      profileType?: string;
      fullName?: string;
      legalName?: string;
      identity?: { kind: string | null; masked: string; validation: string };
      taxOffice?: string;
      invoiceAddress?: string;
      email?: string;
      seller?: { legalName?: string; taxOffice?: string; taxNumber?: string; address?: string };
    };
    tax?: { policy?: string; totals?: { net: number; tax: number; gross: number; currency: string } };
  };
  documents?: InvoiceDocument[];
};

export type LegalInvoiceProfile = {
  organization_id: string;
  legal_name: string;
  tax_office: string;
  tax_number: string;
  address: string;
  invoice_email: string;
  price_tax_policy: "inclusive" | "exclusive";
  default_tax_rate: number;
  shipping_tax_rate: number;
  e_document_provider: string;
  provider_config_ref: string | null;
  invoice_retention_years: number;
};

export function fetchInvoices() { return authenticatedRequest<ApiInvoice[]>("/invoices"); }
export function fetchInvoiceDetail(id: string) { return authenticatedRequest<ApiInvoice>(`/invoices/${id}`); }
export function fetchLegalInvoiceProfile() { return authenticatedRequest<LegalInvoiceProfile>("/invoices/legal-profile"); }
export function updateLegalInvoiceProfile(payload: Record<string, unknown>) {
  return authenticatedRequest<LegalInvoiceProfile>("/invoices/legal-profile", { method: "PUT", body: JSON.stringify(payload) });
}
export function createManualInvoice(orderId: number, idempotencyKey: string) {
  return authenticatedRequest<{ invoice: ApiInvoice; replay: boolean }>("/invoices", {
    method: "POST", body: JSON.stringify({ orderId, provider: "manual", invoiceType: "sale", idempotencyKey }),
  });
}
export function issueManualInvoice(id: string, invoiceNumber: string) {
  return authenticatedRequest<ApiInvoice>(`/invoices/${id}/issue`, {
    method: "POST", body: JSON.stringify({ invoiceNumber }),
  });
}
export function cancelManualInvoice(id: string) {
  return authenticatedRequest<ApiInvoice>(`/invoices/${id}/cancel`, { method: "POST", body: "{}" });
}
export function uploadInvoiceDocument(id: string, file: File) {
  const body = new FormData();
  body.append("document", file);
  return authenticatedRequest<InvoiceDocument>(`/invoices/${id}/documents`, { method: "POST", body });
}
