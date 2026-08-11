const VARIANT_ADMIN_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];

function isAdminManagementRequest(req) {
  const auth = req && req.auth;
  return Boolean(auth && auth.actorType === 'admin' && VARIANT_ADMIN_ROLES.includes(auth.role));
}

module.exports = { isAdminManagementRequest, VARIANT_ADMIN_ROLES };
