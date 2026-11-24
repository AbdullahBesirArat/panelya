async function assertWorkspaceHasNoReconciliationCases(client, organizationId) {
  // Cases, evidence and identity claims are retained financial records (append-only, ON DELETE RESTRICT).
  for (const table of ['payment_reconciliation_cases', 'payment_evidence', 'payment_identity_claims']) {
    const result = await client.query(
      `select 1 from ${table} where organization_id = $1 limit 1`,
      [organizationId]
    );
    if (result.rowCount > 0) {
      throw new Error('Workspace temizlenemedi: saklanan odeme mutabakat vakalari veya odeme kanitlari var.');
    }
  }
}

module.exports = { assertWorkspaceHasNoReconciliationCases };
