// src/middlewares/cors.js
function parseAllowedOrigins(CORS_ORIGINS) {
  return String(CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsMiddleware(cfg) {
  const allowedOrigins = parseAllowedOrigins(cfg.CORS_ORIGINS);

  return function cors(req, res, next) {
    const origin = req.headers.origin;

    // Se não setar CORS_ORIGINS, libera geral (útil em dev)
    if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Office-Secret,X-Admin-Secret");
    }

    if (req.method === "OPTIONS") return res.status(204).send("");
    next();
  };
}

module.exports = { corsMiddleware };
