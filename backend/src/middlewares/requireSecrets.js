// src/middlewares/requireSecrets.js
function requireOfficeAuth(cfg) {
  return function (req, res, next) {
    const secret = req.headers["x-office-secret"];
    if (!secret || String(secret) !== String(cfg.OFFICE_API_SECRET)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  };
}

function requireAdminAuth(cfg) {
  return function (req, res, next) {
    const secret = req.headers["x-admin-secret"];
    if (!secret || String(secret) !== String(cfg.ADMIN_API_SECRET)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  };
}

module.exports = { requireOfficeAuth, requireAdminAuth };
