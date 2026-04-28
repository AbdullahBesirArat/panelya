process.env.ALLOW_DEMO_SEED = 'true';
process.env.FORCE_DEMO_SEED = 'true';
process.env.DEMO_ORGANIZATION_NAME = process.env.SUVERA_ORGANIZATION_NAME || 'Suvera';
process.env.DEMO_ORGANIZATION_SLUG = 'suvera';
process.env.DEMO_OWNER_EMAIL = process.env.SUVERA_OWNER_EMAIL || 'admin@suvera.com.tr';
process.env.DEMO_OWNER_NAME = process.env.SUVERA_OWNER_NAME || 'Suvera Owner';

require('./seed-demo-workspace');
