// Copy this file to config.js in the Suvera storefront deployment.
// In production the storefront keeps API traffic on same-origin /api via the local proxy route.
window.SUVERA_ORGANIZATION_SLUG = 'suvera';
window.SUVERA_PUBLIC_ACCESS_TOKEN = window.SUVERA_PUBLIC_ACCESS_TOKEN || '';
window.SUVERA_SITE_ORIGIN = window.SUVERA_SITE_ORIGIN || location.origin;
window.SUVERA_IBAN_INFO = window.SUVERA_IBAN_INFO || {
  accountName: 'Suvera',
  bankName: '',
  iban: '',
};
window.PANELYA_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "https://panelya-api-production.up.railway.app/api"
  : "/api";
window.SUVERA_API_BASE = window.PANELYA_API_BASE;
