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
const { slugify } = require('../services/tenant');

const router = express.Router();

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

async function appMemberships(client, userId) {
  const result = await client.query(
    `select
       m.role,
       o.id as organization_id,
       o.name as organization_name,
       o.slug as organization_slug,
       o.plan as organization_plan,
       o.status as organization_status
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

async function handleAdminLogin(req, res, next) {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password || username.length > 80 || password.length > 200) {
      return res.status(400).json({ error: 'Kullanici adi ve sifre zorunlu' });
    }

    const result = await db.query(
      'select id, username, password_hash, role from admins where username = $1 limit 1',
      [username]
    );

    const admin = result.rows[0];
    const fallbackEnabled = !isProduction() && process.env.ALLOW_ENV_ADMIN_LOGIN === 'true';
    const fallbackUser = process.env.ADMIN_USERNAME || '';
    const fallbackPassHash = process.env.ADMIN_PASSWORD_HASH || '';

    let isValid = false;
    let adminId = admin?.id || 0;
    let role = admin?.role || 'viewer';

    if (admin) {
      isValid = await bcrypt.compare(password, admin.password_hash);
    } else if (fallbackEnabled && fallbackPassHash && username === fallbackUser) {
      isValid = await bcrypt.compare(password, fallbackPassHash);
      role = 'super_admin';
    }

    if (!isValid) {
      await auditLog(req, {
        action: 'LOGIN',
        resourceType: 'admin',
        resourceId: username,
        success: false,
        errorMessage: 'invalid credentials',
      });
      return res.status(401).json({ error: 'Giris bilgileri hatali' });
    }

    const token = createAdminAccessToken({
      id: adminId,
      username,
      role,
    });

    req.auth = { sub: adminId, username, role, actorType: 'admin' };
    req.admin = req.auth;
    await auditLog(req, {
      action: 'LOGIN',
      resourceType: 'admin',
      resourceId: adminId,
      newValue: { username, role },
    });

    res.json({ token, admin: { id: adminId, username, role } });
  } catch (err) {
    next(err);
  }
}

router.post('/login', loginLimiter, handleAdminLogin);
router.post('/admin/login', loginLimiter, handleAdminLogin);

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
 *                 example: Maveran
 *               organizationSlug:
 *                 type: string
 *                 example: maveran
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
    const userResult = await client.query(
      `insert into app_users (email, name, password_hash)
       values ($1, $2, $3)
       returning id, email, name`,
      [email, name, passwordHash]
    );

    const organizationResult = await client.query(
      `insert into organizations (name, slug, plan, status)
       values ($1, $2, 'starter', 'trialing')
       returning id, name, slug, plan, status`,
      [organizationName, organizationSlug]
    );

    await client.query(
      `insert into memberships (organization_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [organizationResult.rows[0].id, userResult.rows[0].id]
    );

    await client.query(
      `insert into subscriptions
       (organization_id, provider, plan, status, current_period_start, current_period_end)
       values ($1, 'manual', 'starter', 'trialing', now(), now() + interval '14 days')`,
      [organizationResult.rows[0].id]
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

    await client.query('commit');
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
 *                 example: maveran
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

    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
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
 *                 example: maveran
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
    const refreshSession = await getRefreshSession(client, refreshToken);
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

module.exports = router;
