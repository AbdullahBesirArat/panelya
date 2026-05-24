const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireActorType, requireAuth } = require('../middleware/auth');
const { isProduction, rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const {
  buildSessionPayload,
  createAdminAccessToken,
  createAppAccessToken,
  getRefreshSession,
  issueRefreshToken,
  revokeRefreshToken,
} = require('../services/authTokens');
const crypto = require('crypto');
const {
  sendWelcomeEmail,
  sendEmailVerificationMagicLink,
  sendEmailChangeConfirmation,
} = require('../services/email');
const { slugify } = require('../services/tenant');
const { logger } = require('../services/logger');

const EMAIL_VERIFICATION_TTL_HOURS = Math.max(1, Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 24));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function issueUserVerificationToken(client, {
  organizationId,
  userId,
  purpose,
  newEmail = null,
}) {
  const token = randomToken();
  await client.query(
    `insert into email_magic_link_tokens
       (organization_id, subject_type, subject_id, purpose, token_hash, new_email, expires_at)
     values ($1, 'user', $2, $3, $4, $5, now() + ($6 || ' hours')::interval)`,
    [
      organizationId,
      String(userId),
      purpose,
      sha256(token),
      newEmail,
      String(EMAIL_VERIFICATION_TTL_HOURS),
    ]
  );
  return token;
}

const router = express.Router();
const DUMMY_PASSWORD_HASH = '$2b$12$QJv3JQv8ZCk1sQxw2P7/fOMQ7A0J7sKnzGWxZmf0RduCMsZ/HXXdK';
const VALID_ORGANIZATION_PLANS = ['starter', 'growth', 'business', 'enterprise'];

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT || 10),
  message: 'Cok fazla giris denemesi. Lutfen biraz sonra tekrar deneyin.',
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_LIMIT || 6),
  message: 'Cok fazla kayit denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 200);
}

function cleanName(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 160);
}

function cleanPassword(value) {
  return String(value || '');
}

function validateAppCredentials({ email, password }) {
  if (!email || !email.includes('@')) {
    return 'Gecerli bir email girin';
  }
  if (!password || password.length < 12 || password.length > 200) {
    return 'Sifre en az 12 karakter olmali';
  }
  return null;
}

function defaultOrganizationPlan() {
  const plan = String(process.env.DEFAULT_ORGANIZATION_PLAN || 'growth').trim().toLowerCase();
  return VALID_ORGANIZATION_PLANS.includes(plan) ? plan : 'growth';
}

async function appMemberships(client, userId) {
  const result = await client.query(
    `select
       m.role,
       o.id as organization_id,
       o.name as organization_name,
       o.slug as organization_slug,
       o.plan as organization_plan,
       o.status as organization_status,
       o.public_access_token as organization_public_access_token
     from memberships m
     join organizations o on o.id = m.organization_id
     where m.user_id = $1
       and m.status = 'active'
       and o.status in ('active', 'trialing', 'past_due')
     order by
       case m.role
         when 'owner' then 1
         when 'admin' then 2
         when 'member' then 3
         else 4
       end,
       o.created_at asc`,
    [userId]
  );

  return result.rows.map((row) => ({
    role: row.role,
    organization: {
      id: row.organization_id,
      name: row.organization_name,
      slug: row.organization_slug,
      plan: row.organization_plan,
      status: row.organization_status,
      publicAccessToken: row.organization_public_access_token,
    },
  }));
}

function pickMembership(memberships, organizationSlug) {
  if (!memberships.length) return null;
  if (!organizationSlug) return memberships[0];
  return memberships.find((membership) => membership.organization.slug === organizationSlug) || null;
}

async function issueAppSession(client, req, user, memberships, currentMembership) {
  const accessToken = createAppAccessToken({
    user,
    membership: currentMembership,
  });
  const refreshToken = await issueRefreshToken(client, {
    userId: user.id,
    req,
  });

  return buildSessionPayload({
    accessToken,
    refreshToken,
    user,
    memberships,
    currentMembership,
  });
}

function legacyAdminDisabled(res) {
  return res.status(410).json({
    error: 'Eski admin girisi kaldirildi. /auth/session/login kullanin.',
    code: 'LEGACY_ADMIN_AUTH_DISABLED',
  });
}

router.post('/login', loginLimiter, async (req, res) => legacyAdminDisabled(res));
router.post('/admin/login', loginLimiter, async (req, res) => legacyAdminDisabled(res));

router.post('/admin/session/login', loginLimiter, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().slice(0, 80);
    const password = cleanPassword(req.body.password);

    if (!username || !password) {
      return res.status(400).json({ error: 'Kullanici adi ve sifre zorunlu' });
    }

    const result = await db.query(
      `select id, username, password_hash, role
       from admins
       where lower(username) = lower($1)
       limit 1`,
      [username]
    );
    const admin = result.rows[0];
    const passwordHashToCompare = admin?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(password, passwordHashToCompare);

    if (!admin || !admin.password_hash || !passwordMatches) {
      await auditLog(req, {
        action: 'ADMIN_LOGIN',
        resourceType: 'session',
        resourceId: username,
        success: false,
        errorMessage: 'invalid admin credentials',
        actorType: 'admin',
      });
      return res.status(401).json({ error: 'Giris bilgileri hatali' });
    }

    if (admin.role !== 'super_admin') {
      req.admin = { sub: admin.id, actorType: 'admin' };
      await auditLog(req, {
        action: 'ADMIN_LOGIN',
        resourceType: 'session',
        resourceId: admin.id,
        success: false,
        errorMessage: 'super_admin role required',
        actorType: 'admin',
        actorAdminId: admin.id,
      });
      return res.status(403).json({ error: 'Superadmin yetkisi gerekli' });
    }

    req.admin = { sub: admin.id, actorType: 'admin' };
    await auditLog(req, {
      action: 'ADMIN_LOGIN',
      resourceType: 'session',
      resourceId: admin.id,
      actorType: 'admin',
      actorAdminId: admin.id,
    });

    res.json({
      actorType: 'admin',
      accessToken: createAdminAccessToken(admin),
      role: admin.role,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Yeni workspace ve owner kullanici olusturur
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, organizationName]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Arat
 *               email:
 *                 type: string
 *                 format: email
 *                 example: owner@panelya.com
 *               password:
 *                 type: string
 *                 minLength: 12
 *                 example: StrongDemo!123
 *               organizationName:
 *                 type: string
 *                 example: Panelya
 *               organizationSlug:
 *                 type: string
 *                 example: panelya
 *     responses:
 *       201:
 *         description: Workspace olusturuldu ve oturum acildi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Session'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       409:
 *         description: Email veya workspace slug zaten kullaniliyor
 */
router.post('/register', registerLimiter, async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const name = cleanName(req.body.name, 'Workspace Owner');
    const email = cleanEmail(req.body.email);
    const password = cleanPassword(req.body.password);
    const organizationName = cleanName(req.body.organizationName, 'My Workspace');
    const organizationSlug = slugify(req.body.organizationSlug || organizationName);
    const validationError = validateAppCredentials({ email, password });

    if (validationError) return res.status(400).json({ error: validationError });
    if (!organizationName || !organizationSlug) {
      return res.status(400).json({ error: 'Workspace adi zorunlu' });
    }

    await client.query('begin');

    const existingUser = await client.query(
      'select id from app_users where lower(email) = lower($1) limit 1',
      [email]
    );
    if (existingUser.rows[0]) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Bu email zaten kullaniliyor' });
    }

    const existingOrg = await client.query(
      'select id from organizations where slug = $1 limit 1',
      [organizationSlug]
    );
    if (existingOrg.rows[0]) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Bu workspace slug zaten kullaniliyor' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const organizationPlan = defaultOrganizationPlan();
    const userResult = await client.query(
      `insert into app_users (email, name, password_hash)
       values ($1, $2, $3)
       returning id, email, name`,
      [email, name, passwordHash]
    );

    const organizationResult = await client.query(
      `insert into organizations (name, slug, plan, status)
       values ($1, $2, $3, 'trialing')
       returning id, name, slug, plan, status`,
      [organizationName, organizationSlug, organizationPlan]
    );

    await client.query(
      `insert into memberships (organization_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [organizationResult.rows[0].id, userResult.rows[0].id]
    );

    await client.query(
      `insert into subscriptions
       (organization_id, provider, plan, status, current_period_start, current_period_end)
       values ($1, 'manual', $2, 'trialing', now(), now() + interval '14 days')`,
      [organizationResult.rows[0].id, organizationPlan]
    );

    const memberships = await appMemberships(client, userResult.rows[0].id);
    const currentMembership = pickMembership(memberships, organizationSlug);
    const session = await issueAppSession(client, req, userResult.rows[0], memberships, currentMembership);

    req.auth = {
      userId: userResult.rows[0].id,
      organizationId: currentMembership.organization.id,
      organizationSlug: currentMembership.organization.slug,
      actorType: 'app',
    };

    const verificationToken = await issueUserVerificationToken(client, {
      organizationId: currentMembership.organization.id,
      userId: userResult.rows[0].id,
      purpose: 'signup',
    });

    await client.query('commit');

    sendEmailVerificationMagicLink({
      to: email,
      name,
      token: verificationToken,
      target: 'panelya',
      organization: currentMembership.organization,
    }).catch((error) => {
      logger.warn({ email, err: error.message }, 'Tenant verification email gonderilemedi');
    });
    await auditLog(req, {
      action: 'REGISTER',
      resourceType: 'organization',
      resourceId: currentMembership.organization.id,
      newValue: {
        userId: userResult.rows[0].id,
        organizationSlug: currentMembership.organization.slug,
      },
      actorType: 'app',
      actorUserId: userResult.rows[0].id,
      organizationId: currentMembership.organization.id,
    });
    await sendWelcomeEmail(userResult.rows[0], currentMembership.organization).catch((error) => {
      console.warn('Welcome email gonderilemedi', { message: error.message });
    });
    res.status(201).json(session);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/auth/session/login:
 *   post:
 *     summary: Workspace kullanicisi ile oturum acar
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: demo@panelya.dev
 *               password:
 *                 type: string
 *                 example: PanelyaDemo!123
 *               organizationSlug:
 *                 type: string
 *                 example: panelya
 *     responses:
 *       200:
 *         description: Oturum acildi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Session'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       429:
 *         description: Cok fazla giris denemesi
 */
router.post('/session/login', loginLimiter, async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const email = cleanEmail(req.body.email);
    const password = cleanPassword(req.body.password);
    const organizationSlug = slugify(req.body.organizationSlug || '');
    const validationError = validateAppCredentials({ email, password });

    if (validationError) return res.status(400).json({ error: validationError });

    await client.query('begin');
    const userResult = await client.query(
      `select id, email, name, password_hash
       from app_users
       where lower(email) = lower($1)
       limit 1`,
      [email]
    );
    const user = userResult.rows[0];

    const passwordHashToCompare = user?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(password, passwordHashToCompare);

    if (!user || !user.password_hash || !passwordMatches) {
      await auditLog(req, {
        action: 'LOGIN',
        resourceType: 'session',
        resourceId: email,
        success: false,
        errorMessage: 'invalid credentials',
        actorType: 'app',
      });
      await client.query('commit');
      return res.status(401).json({ error: 'Giris bilgileri hatali' });
    }

    const memberships = await appMemberships(client, user.id);
    const currentMembership = pickMembership(memberships, organizationSlug);
    if (!currentMembership) {
      await client.query('rollback');
      return res.status(403).json({ error: 'Bu workspace icin erisiminiz yok' });
    }

    await client.query(
      'update app_users set last_login_at = now(), updated_at = now() where id = $1',
      [user.id]
    );

    const session = await issueAppSession(client, req, user, memberships, currentMembership);
    req.auth = {
      userId: user.id,
      organizationId: currentMembership.organization.id,
      organizationSlug: currentMembership.organization.slug,
      actorType: 'app',
    };

    await auditLog(req, {
      action: 'LOGIN',
      resourceType: 'session',
      resourceId: user.id,
      newValue: { organizationSlug: currentMembership.organization.slug },
      actorType: 'app',
      actorUserId: user.id,
      organizationId: currentMembership.organization.id,
    });

    await client.query('commit');
    res.json(session);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/auth/session/refresh:
 *   post:
 *     summary: Refresh token ile yeni access token uretir
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *               organizationSlug:
 *                 type: string
 *                 example: panelya
 *     responses:
 *       200:
 *         description: Oturum yenilendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Session'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post('/session/refresh', async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const refreshToken = String(req.body.refreshToken || '');
    const requestedOrganizationSlug = slugify(req.body.organizationSlug || '');
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token zorunlu' });

    await client.query('begin');
    const refreshSession = await getRefreshSession(client, refreshToken, { forUpdate: true });
    if (!refreshSession) {
      await client.query('rollback');
      return res.status(401).json({ error: 'Refresh token gecersiz' });
    }

    const userResult = await client.query(
      `select id, email, name
       from app_users
       where id = $1
       limit 1`,
      [refreshSession.user_id]
    );
    const user = userResult.rows[0];
    const memberships = await appMemberships(client, refreshSession.user_id);
    const currentMembership = pickMembership(memberships, requestedOrganizationSlug);

    if (!user || !currentMembership) {
      await revokeRefreshToken(client, refreshToken);
      await client.query('commit');
      return res.status(403).json({ error: 'Oturum yenilenemedi' });
    }

    await revokeRefreshToken(client, refreshToken);
    const session = await issueAppSession(client, req, user, memberships, currentMembership);
    await client.query('commit');
    res.json(session);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/auth/session/logout:
 *   post:
 *     summary: Refresh token'i iptal edip oturumu kapatir
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Oturum kapatildi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 */
router.post('/session/logout', async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const refreshToken = String(req.body.refreshToken || '');

    await client.query('begin');
    if (refreshToken) {
      await revokeRefreshToken(client, refreshToken);
    }
    await client.query('commit');
    res.json({ ok: true });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/session/switch-organization', requireAuth, requireActorType(['app']), async (req, res, next) => {
  try {
    const organizationSlug = slugify(req.body.organizationSlug || '');
    if (!organizationSlug) return res.status(400).json({ error: 'Workspace secin' });

    const memberships = await appMemberships(db, req.auth.userId);
    const currentMembership = pickMembership(memberships, organizationSlug);
    if (!currentMembership) return res.status(403).json({ error: 'Bu workspace icin erisiminiz yok' });

    const userResult = await db.query(
      'select id, email, name from app_users where id = $1 limit 1',
      [req.auth.userId]
    );
    const user = userResult.rows[0];
    const accessToken = createAppAccessToken({
      user,
      membership: currentMembership,
    });

    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || '',
      },
      currentOrganization: {
        ...currentMembership.organization,
        role: currentMembership.role,
      },
      role: currentMembership.role,
      organizations: memberships.map((membership) => ({
        ...membership.organization,
        role: membership.role,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Aktif kullanici ve workspace bilgisini dondurur
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Profil bilgisi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 actorType:
 *                   type: string
 *                   enum: [app, admin]
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 currentOrganization:
 *                   $ref: '#/components/schemas/Organization'
 *                 role:
 *                   type: string
 *                 organizations:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Organization'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    if (req.auth.actorType === 'admin') {
      return res.json({
        actorType: 'admin',
        admin: {
          id: req.auth.sub,
          username: req.auth.username,
          role: req.auth.role,
        },
      });
    }

    const userResult = await db.query(
      'select id, email, name from app_users where id = $1 limit 1',
      [req.auth.userId]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'Kullanici bulunamadi' });

    const memberships = await appMemberships(db, req.auth.userId);
    const currentMembership = pickMembership(memberships, req.auth.organizationSlug) || memberships[0];
    if (!currentMembership) return res.status(403).json({ error: 'Aktif workspace bulunamadi' });

    res.json({
      actorType: 'app',
      user: {
        id: user.id,
        email: user.email,
        name: user.name || '',
      },
      currentOrganization: {
        ...currentMembership.organization,
        role: currentMembership.role,
      },
      role: currentMembership.role,
      organizations: memberships.map((membership) => ({
        ...membership.organization,
        role: membership.role,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-email', registerLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const token = String(req.body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Dogrulama token zorunlu' });
    const tokenHash = sha256(token);

    await client.query('begin');
    const result = await client.query(
      `select id, subject_id, organization_id, new_email
         from email_magic_link_tokens
        where token_hash = $1
          and subject_type = 'user'
          and purpose = 'signup'
          and consumed_at is null
          and expires_at > now()
        limit 1
        for update`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('rollback');
      return res.status(400).json({ error: 'Dogrulama linki gecersiz veya suresi doldu' });
    }
    await client.query(
      'update app_users set email_verified_at = now(), updated_at = now() where id = $1',
      [row.subject_id]
    );
    await client.query(
      'update email_magic_link_tokens set consumed_at = now() where id = $1',
      [row.id]
    );
    await client.query('commit');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

router.post('/resend-verification', registerLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const email = cleanEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Email zorunlu' });

    const userResult = await client.query(
      `select u.id, u.email, u.name, u.email_verified_at,
              m.organization_id,
              o.name as organization_name,
              o.slug as organization_slug
         from app_users u
         left join memberships m on m.user_id = u.id and m.status = 'active'
         left join organizations o on o.id = m.organization_id
        where lower(u.email) = lower($1)
        order by m.id asc
        limit 1`,
      [email]
    );
    const user = userResult.rows[0];
    if (user && !user.email_verified_at && user.organization_id) {
      await client.query('begin');
      const token = await issueUserVerificationToken(client, {
        organizationId: user.organization_id,
        userId: user.id,
        purpose: 'signup',
      });
      await client.query('commit');
      sendEmailVerificationMagicLink({
        to: user.email,
        name: user.name,
        token,
        target: 'panelya',
        organization: { name: user.organization_name, slug: user.organization_slug },
      }).catch((error) => {
        logger.warn({ email, err: error.message }, 'Tenant resend verification gonderilemedi');
      });
    }
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

router.post('/email-change/request', requireAuth, requireActorType(['app']), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const newEmail = cleanEmail(req.body.new_email);
    const password = cleanPassword(req.body.password);
    if (!newEmail || !newEmail.includes('@')) {
      return res.status(400).json({ error: 'Gecerli email zorunlu' });
    }
    if (!password) return res.status(400).json({ error: 'Mevcut parola zorunlu' });

    const userResult = await client.query(
      'select id, email, name, password_hash from app_users where id = $1 limit 1',
      [req.auth.userId]
    );
    const user = userResult.rows[0];
    const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !user.password_hash || !passwordMatches) {
      return res.status(401).json({ error: 'Parola hatali' });
    }
    if (newEmail.toLowerCase() === String(user.email).toLowerCase()) {
      return res.status(400).json({ error: 'Yeni email mevcut email ile ayni' });
    }

    const conflict = await client.query(
      'select id from app_users where lower(email) = lower($1) limit 1',
      [newEmail]
    );
    if (conflict.rows[0]) {
      return res.status(409).json({ error: 'Bu email baska bir hesapta kullaniliyor' });
    }

    await client.query('begin');
    const token = await issueUserVerificationToken(client, {
      organizationId: req.auth.organizationId,
      userId: user.id,
      purpose: 'email_change',
      newEmail,
    });
    await client.query('commit');

    sendEmailChangeConfirmation({
      to: newEmail,
      name: user.name || '',
      token,
      target: 'panelya',
      organization: { name: req.auth.organizationSlug },
    }).catch((error) => {
      logger.warn({ email: newEmail, err: error.message }, 'Tenant email-change mail gonderilemedi');
    });

    res.json({ ok: true });
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

router.post('/password/change', requireAuth, requireActorType(['app']), async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const currentPassword = cleanPassword(req.body.current_password || req.body.currentPassword);
    const newPassword = cleanPassword(req.body.new_password || req.body.newPassword);
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Gecerli email zorunlu' });
    }
    if (!currentPassword) return res.status(400).json({ error: 'Mevcut sifre zorunlu' });

    const passwordError = validateAppCredentials({ email, password: newPassword });
    if (passwordError) return res.status(400).json({ error: passwordError });

    const userResult = await db.query(
      'select id, email, name, password_hash from app_users where id = $1 limit 1',
      [req.auth.userId]
    );
    const user = userResult.rows[0];
    if (!user || cleanEmail(user.email) !== email) {
      await bcrypt.compare(currentPassword, DUMMY_PASSWORD_HASH);
      return res.status(400).json({ error: 'E-posta veya sifre hatali' });
    }

    const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash || DUMMY_PASSWORD_HASH);
    if (!user.password_hash || !passwordMatches) {
      return res.status(401).json({ error: 'E-posta veya sifre hatali' });
    }

    if (await bcrypt.compare(newPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Yeni sifre mevcut sifre ile ayni olamaz' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      'update app_users set password_hash = $1, updated_at = now() where id = $2',
      [passwordHash, user.id]
    );

    await auditLog(req, {
      action: 'CHANGE_PASSWORD',
      resourceType: 'app_user',
      resourceId: user.id,
      newValue: { email: user.email },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/email-change/confirm', registerLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const token = String(req.body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Dogrulama token zorunlu' });
    const tokenHash = sha256(token);

    await client.query('begin');
    const tokenResult = await client.query(
      `select id, subject_id, new_email
         from email_magic_link_tokens
        where token_hash = $1
          and subject_type = 'user'
          and purpose = 'email_change'
          and consumed_at is null
          and expires_at > now()
        limit 1
        for update`,
      [tokenHash]
    );
    const row = tokenResult.rows[0];
    if (!row || !row.new_email) {
      await client.query('rollback');
      return res.status(400).json({ error: 'Dogrulama linki gecersiz veya suresi doldu' });
    }

    const conflict = await client.query(
      'select id from app_users where lower(email) = lower($1) and id <> $2 limit 1',
      [row.new_email, row.subject_id]
    );
    if (conflict.rows[0]) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Bu email baska bir hesapta kullaniliyor' });
    }

    await client.query(
      `update app_users
          set email = $1, email_verified_at = now(), updated_at = now()
        where id = $2`,
      [row.new_email, row.subject_id]
    );
    await client.query(
      'update email_magic_link_tokens set consumed_at = now() where id = $1',
      [row.id]
    );
    await client.query('commit');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('rollback'); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
