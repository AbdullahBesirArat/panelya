async function assertWorkspaceHasNoReconciliationCases(client, organizationId) {
  const result = await client.query(
    'select 1 from payment_reconciliation_cases where organization_id = $1 limit 1',
    [organizationId]
  );
  if (result.rowCount > 0) {
    throw new Error('Workspace temizlenemedi: saklanan odeme mutabakat vakalari var.');
  }
}

module.exports = { assertWorkspaceHasNoReconciliationCases };
