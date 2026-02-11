// src/middlewares/requireSecrets.js

function requireOfficeAuth(cfg = process.env) {
  return function (req, res, next) {
    try {
      const expected = String(cfg.OFFICE_API_SECRET || "").trim();
      if (!expected) {
        console.error("OFFICE_API_SECRET não definido no ambiente.");
        return res.status(500).json({ ok: false, error: "server_misconfigured" });
      }

      const provided =
        req.headers["x-office-secret"] ||
        req.headers["X-Office-Secret"] ||
        "";

      if (!provided || String(provided).trim() !== expected) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      return next();
    } catch (e) {
      console.error("requireOfficeAuth error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  };
}

function requireAdminAuth(cfg = process.env) {
  return function (req, res, next) {
    try {
      const expected = String(cfg.ADMIN_API_SECRET || "").trim();
      if (!expected) {
        console.error("ADMIN_API_SECRET não definido no ambiente.");
        return res.status(500).json({ ok: false, error: "server_misconfigured" });
      }

      const provided =
        req.headers["x-admin-secret"] ||
        req.headers["X-Admin-Secret"] ||
        "";

      if (!provided || String(provided).trim() !== expected) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      return next();
    } catch (e) {
      console.error("requireAdminAuth error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  };
}

module.exports = { requireOfficeAuth, requireAdminAuth };
