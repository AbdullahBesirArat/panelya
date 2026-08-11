require('dotenv').config();

const { Client } = require('pg');

const ROLE_PASSWORD_ENV = {
  panelya_migrator: 'MIGRATION_DATABASE_PASSWORD',
  panelya_runtime: 'RUNTIME_DATABASE_PASSWORD',
  panelya_system_runtime: 'SYSTEM_DATABASE_PASSWORD',
};

function required(name) {
  const value = String(process.env[name] || '');
  if (value.length < 24) throw new Error(`${name} en az 24 karakter olmali`);
  return value;
}

async function main() {
  const adminUrl = required('DATABASE_ADMIN_URL');
  const passwords = Object.fromEntries(
    Object.entries(ROLE_PASSWORD_ENV).map(([role, envName]) => [role, required(envName)])
  );
  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  try {
    await client.query('begin');
    await client.query('create extension if not exists pgcrypto');
    await client.query('create extension if not exists pg_trgm');
    await client.query('create extension if not exists unaccent');
    await client.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'panelya_migrator') then
          create role panelya_migrator login;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'panelya_runtime') then
          create role panelya_runtime login;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'panelya_rls_bypass') then
          create role panelya_rls_bypass nologin;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'panelya_system_runtime') then
          create role panelya_system_runtime login;
        end if;
      end $$;

      alter role panelya_migrator nosuperuser nobypassrls nocreatedb nocreaterole inherit;
      alter role panelya_runtime nosuperuser nobypassrls nocreatedb nocreaterole inherit;
      alter role panelya_rls_bypass nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
      alter role panelya_system_runtime noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
      revoke panelya_rls_bypass from panelya_runtime;
      grant panelya_rls_bypass to panelya_system_runtime;
    `);

    for (const [role, password] of Object.entries(passwords)) {
      await client.query(
        `alter role ${client.escapeIdentifier(role)} password ${client.escapeLiteral(password)}`
      );
    }

    await client.query(`
      revoke create on schema public from public;
      grant usage, create on schema public to panelya_migrator;
      grant usage on schema public to panelya_runtime, panelya_system_runtime;
      grant select, insert, update, delete on all tables in schema public to panelya_runtime, panelya_system_runtime;
      grant usage, select on all sequences in schema public to panelya_runtime, panelya_system_runtime;
      alter default privileges for role panelya_migrator in schema public
        grant select, insert, update, delete on tables to panelya_runtime, panelya_system_runtime;
      alter default privileges for role panelya_migrator in schema public
        grant usage, select on sequences to panelya_runtime, panelya_system_runtime;
    `);
    await client.query('commit');
    console.log('Database roles provisioned without exposing credentials.');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
