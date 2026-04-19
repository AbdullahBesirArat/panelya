# Panelya / Maveran Project Split

## Product Boundaries

- Panelya is the SaaS operations platform.
- Maveran is the e-commerce storefront brand managed from Panelya.
- Panelya owns the dashboard, API, auth, tenant isolation, products, orders, customers, content and analytics.
- Maveran owns the public shopping experience: homepage, product listing, product detail, cart and checkout.

## Recommended Deployments

Panelya:

- Web dashboard: `apps/web`
- API: `panelya-api`
- Database: PostgreSQL/Neon
- Suggested domains: `panelya.com.tr` and `api.panelya.com.tr`

Maveran:

- Static storefront files: `maveran-storefront`
- Suggested domains: `maveran.com.tr` and `www.maveran.com.tr`

## Integration Model

Maveran storefront should read public catalog/content data from Panelya API and send checkout/payment/order requests back to Panelya.

Use `organizationSlug=maveran` for Maveran storefront data. Admin/dashboard users manage that same workspace through Panelya.

## Naming Rule

- Use Panelya for platform UI, API docs, package names, deploy docs and SaaS wording.
- Use Maveran only when referring to the managed store/workspace or the public storefront project.
