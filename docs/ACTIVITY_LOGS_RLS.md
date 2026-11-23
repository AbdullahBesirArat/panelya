# Activity log row-level security

Migration 074 enables and forces PostgreSQL row-level security on `public.activity_logs`. It changes policies and grants without rewriting rows. Existing tenant and NULL-organization history stays available to the system role.

| Policy | Runtime role | System role |
| --- | --- | --- |
| SELECT | Rows matching the transaction-local `app.current_organization_id` | All rows, including NULL organizations |
| INSERT | Rows matching the transaction-local `app.current_organization_id` | Tenant and NULL-organization events |
| DELETE | Denied by ACL and policy | Allowed for scoped maintenance queries |
| UPDATE | Denied by ACL and absence of a policy | Denied by absence of a policy |

A missing or empty setting denies tenant access by default. A malformed nonempty setting raises `22P02` when a tenant policy evaluates it. The system branch checks `public.app_rls_bypassed()` before parsing the tenant setting.

`panelya_runtime` has SELECT and INSERT and is outside the `panelya_rls_bypass` marker role. `panelya_system_runtime` is a member of that marker and remains subject to the explicit policies. Both roles use `NOBYPASSRLS`. FORCE also subjects the ordinary table owner to the policies during data access. The owner retains DDL authority. Superusers and roles with PostgreSQL's native `BYPASSRLS` can bypass these policies even with FORCE. Native bypass roles still need applicable table privileges. Tenant scoping relies on trusted server code assigning the tenant setting. A caller with arbitrary SQL access as the runtime role can set that value. Existing foreign-key actions continue to apply.

The audit helper uses a caller-supplied tenant transaction or the active request transaction when available. A savepoint protects either transaction from a rejected activity insert. Without an active request tenant, an event with an organization uses a short runtime transaction with that tenant setting. Events without an organization use the system pool. A request tenant mismatch is rejected before SQL, and a denied tenant insert has no system retry.

## Rollout and rollback

1. Ensure the system database role and `SYSTEM_DATABASE_URL` are configured. Deploy the compatible API and seed code first and let old API instances drain. If the migration runs before cutover, old instances can drop best-effort audit writes in the seconds before they drain.
2. Apply migration 074 with `npm run db:migrate` from the repo root. The migration runner wraps the SQL and checksum record in one transaction. The table lock has a 10-second acquisition timeout. If the migration times out, retry after the blocking transaction has ended.
3. Verify the flags, policies and runtime ACL with the read-only queries below. Verify the role setup and event writes on a disposable database before production rollout.
4. To roll back, use `npm --prefix panelya-api run db:rollback -- 074_activity_logs_rls.sql` from the repo root. This drops the three policies, disables RLS and FORCE, and restores the standard runtime UPDATE and DELETE grants. The rollback keeps history and `app_rls_bypassed()`. Record any custom ACL baseline before rollout so it can be restored during rollback. The compatible API can run before and after the rollback.

Demo reseeding deletes activity for the guarded workspace through the system pool near the end of the seed. That delete commits independently from the runtime seed transaction. If the final runtime commit fails, previous workspace activity may already have been removed.

## Read-only verification

```sql
select c.relrowsecurity, c.relforcerowsecurity
from pg_class c
where c.oid = 'public.activity_logs'::regclass;

select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'activity_logs'
order by policyname;

select rolname, rolbypassrls,
       pg_has_role(oid, 'panelya_rls_bypass', 'MEMBER') as marker_member,
       has_table_privilege(oid, 'public.activity_logs', 'SELECT') as can_select,
       has_table_privilege(oid, 'public.activity_logs', 'INSERT') as can_insert,
       has_table_privilege(oid, 'public.activity_logs', 'UPDATE') as can_update,
       has_table_privilege(oid, 'public.activity_logs', 'DELETE') as can_delete
from pg_roles
where rolname in ('panelya_runtime', 'panelya_system_runtime')
order by rolname;
```

Expect both flags to be true, three policies, and a runtime role with SELECT and INSERT only. The system role should have marker membership, SELECT, INSERT and DELETE, and `rolbypassrls = false`. A legacy system UPDATE grant is ineffective because no UPDATE policy permits it.
