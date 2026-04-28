const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { rateLimit } = require('../middleware/security');
const { resolveOrganization } = require('../services/tenant');
const { sendCustomerPasswordResetEmail } = require('../services/email');

const router = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CUSTOMER_AUTH_RATE_LIMIT || 20),
  message: 'Cok fazla hesap islemi. Lutfen biraz sonra tekrar deneyin.',
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(36).toString('hex');
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!email || !email.includes('@')) {
    throw Object.assign(new Error('Gecerli email zorunlu'), { status: 400 });
  }
  return email;
}

function cleanPassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 200) {
    throw Object.assign(new Error('Sifre en az 8 karakter olmali'), { status: 400 });
  }
  return password;
}

function publicAccount(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    phone: row.phone || '',
    customer_id: row.customer_id || null,
    last_login_at: row.last_login_at || null,
  };
}

async function issueSession(client, accountId) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await client.query(
    `update customer_accounts
     set session_token_hash = $1,
         session_expires_at = $2,
         last_login_at = now(),
         updated_at = now()
     where id = $3
     returning id, email, name, phone, customer_id, last_login_at`,
    [sha256(token), expiresAt, accountId]
  );

  return {
    accessToken: token,
    account: publicAccount(result.rows[0]),
  };
}

async function requireCustomerAccount(req, client = db) {
  const header = String(req.get('authorization') || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    throw Object.assign(new Error('Musteri oturumu zorunlu'), { status: 401 });
  }

  const organization = await resolveOrganization(req, client, { allowPublic: true });
  const result = await client.query(
    `select id, organization_id, customer_id, email, name, phone, last_login_at
     from customer_accounts
     where organization_id = $1
       and session_token_hash = $2
       and session_expires_at > now()
     limit 1`,
    [organization.id, sha256(token)]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error('Musteri oturumu gecersiz'), { status: 401 });
  }

  return { organization, account: result.rows[0] };
}

async function accountOrders(client, organizationId, customerId) {
  if (!customerId) return [];
  const result = await client.query(
    `select
       o.id,
       o.order_code,
       o.total,
       o.status,
       o.payment_provider,
       o.payment_method,
       o.note,
       o.gift_wrap,
       o.shipping_fee,
       o.shipping_company,
       o.tracking_number,
       o.tracking_url,
       o.shipped_at,
       o.created_at,
       o.updated_at,
       coalesce(
         json_agg(
           json_build_object(
             'product_id', oi.product_id,
             'name', oi.product_name,
             'quantity', oi.quantity,
             'unit_price', oi.unit_price
           )
           order by oi.id
         ) filter (where oi.id is not null),
         '[]'::json
       ) as items
     from orders o
     left join order_items oi on oi.order_id = o.id
     where o.organization_id = $1 and o.customer_id = $2
     group by o.id
     order by o.created_at desc
     limit 50`,
    [organizationId, customerId]
  );
  return result.rows;
}

async function upsertAccountCustomer(client, organizationId, { name, email, phone, address }) {
  const existing = await client.query(
    `select id
     from customers
     where organization_id = $1 and lower(email) = $2
     order by updated_at desc, id desc
     limit 1
     for update`,
    [organizationId, email]
  );

  if (existing.rows[0]) {
    const result = await client.query(
      `update customers
       set name = $1,
           phone = coalesce(nullif($2, ''), phone),
           address = coalesce(nullif($3, ''), address),
           updated_at = now()
       where id = $4 and organization_id = $5
       returning id`,
      [name, phone, address, existing.rows[0].id, organizationId]
    );
    return result.rows[0];
  }

  const inserted = await client.query(
    `insert into customers (organization_id, name, email, phone, address)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [organizationId, name, email, phone, address || '']
  );
  return inserted.rows[0];
}

router.post('/register', authLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const email = cleanEmail(req.body.email);
    const password = cleanPassword(req.body.password);
    const name = String(req.body.name || email.split('@')[0]).trim().slice(0, 160);
    const phone = String(req.body.phone || '').trim().slice(0, 40);

    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    const customer = await upsertAccountCustomer(client, organization.id, {
      name,
      email,
      phone,
      address: String(req.body.address || '').trim(),
    });
    const passwordHash = await bcrypt.hash(password, 12);
    const created = await client.query(
      `insert into customer_accounts (organization_id, customer_id, email, name, phone, password_hash)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (organization_id, email) do update set
         customer_id = coalesce(customer_accounts.customer_id, excluded.customer_id),
         name = excluded.name,
         phone = excluded.phone,
         password_hash = excluded.password_hash,
         updated_at = now()
       returning id`,
      [organization.id, customer.id, email, name, phone, passwordHash]
    );
    const session = await issueSession(client, created.rows[0].id);
    await client.query('commit');
    res.status(201).json(session);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    const result = await client.query(
      `select id, password_hash
       from customer_accounts
       where organization_id = $1 and email = $2
       limit 1`,
      [organization.id, email]
    );
    const account = result.rows[0];
    const valid = account ? await bcrypt.compare(password, account.password_hash) : false;
    if (!valid) return res.status(401).json({ error: 'Giris bilgileri hatali' });

    const session = await issueSession(client, account.id);
    res.json(session);
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get('/me', authLimiter, async (req, res, next) => {
  try {
    const { organization, account } = await requireCustomerAccount(req);
    const orders = await accountOrders(db, organization.id, account.customer_id);
    res.json({ account: publicAccount(account), orders });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', authLimiter, async (req, res, next) => {
  try {
    const { account } = await requireCustomerAccount(req);
    await db.query(
      `update customer_accounts
       set session_token_hash = null,
           session_expires_at = null,
           updated_at = now()
       where id = $1`,
      [account.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/password-reset/request', authLimiter, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const token = randomToken();
    const result = await db.query(
      `update customer_accounts
       set reset_token_hash = $1,
           reset_expires_at = now() + interval '1 hour',
           updated_at = now()
       where organization_id = $2 and email = $3
       returning email, name`,
      [sha256(token), organization.id, email]
    );

    if (result.rows[0]) {
      await sendCustomerPasswordResetEmail(result.rows[0], organization, token).catch((error) => {
        console.warn('Customer reset email gonderilemedi', { email, message: error.message });
      });
    }

    res.json({
      ok: true,
      resetToken: process.env.NODE_ENV === 'production' ? undefined : (result.rows[0] ? token : undefined),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/password-reset/confirm', authLimiter, async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    const password = cleanPassword(req.body.password);
    if (!token) return res.status(400).json({ error: 'Sifirlama token zorunlu' });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `update customer_accounts
       set password_hash = $1,
           reset_token_hash = null,
           reset_expires_at = null,
           updated_at = now()
       where reset_token_hash = $2
         and reset_expires_at > now()
       returning id`,
      [passwordHash, sha256(token)]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Sifirlama baglantisi gecersiz veya suresi doldu' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
