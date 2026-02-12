// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

// ============================
// CFG (normaliza env + service account)
// ============================
function parseServiceAccountFromEnv(env) {
  const raw =
    env.FIREBASE_SERVICE_ACCOUNT ||
    env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    "";

  const s = String(raw || "").trim();
  if (!s) return null;

  // JSON direto
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = JSON.parse(s);
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  }

  // Base64
  try {
    const decoded = Buffer.from(s, "base64").toString("utf8").trim();
    if (decoded.startsWith("{") && decoded.endsWith("}")) {
      const obj = JSON.parse(decoded);
      if (obj.private_key && typeof obj.private_key === "string") {
        obj.private_key = obj.private_key.replace(/\\n/g, "\n");
      }
      return obj;
    }
  } catch (_) {}

  return null;
}

function buildCfgFromEnv(env) {
  const cfg = { ...env };
  cfg._SERVICE_ACCOUNT_JSON = parseServiceAccountFromEnv(env);
  return cfg;
}

// ============================
// Router loader
// ============================
function pickExport(mod) {
  if (!mod) return null;
  return mod.router || mod.officeRouter || mod.adminRouter || mod.telegramRouter || mod.default || mod;
}

function assertRouterValid(router, name) {
  if (!router) throw new Error(`${name}: router é null/undefined`);

  const stack = router.stack;
  if (!Array.isArray(stack)) {
    if (typeof router !== "function") {
      throw new Error(`${name}: não é function e não tem stack`);
    }
    return;
  }

  for (const layer of stack) {
    if (layer && layer.route && Array.isArray(layer.route.stack)) {
      for (const r of layer.route.stack) {
        if (!r || typeof r.handle !== "function") {
          const methods = Object.keys(layer.route.methods || {}).join(",") || "unknown";
          const path = layer.route.path || "(unknown)";
          throw new Error(`${name}: handler inválido em route ${methods.toUpperCase()} ${path}`);
        }
      }
      continue;
    }

    if (!layer || typeof layer.handle !== "function") {
      throw new Error(`${name}: middleware inválido`);
    }
  }
}

// ============================
// Boot
// ============================
const cfg = buildCfgFromEnv(process.env);

// ✅ Firebase Admin init
const fbAdminMod = require("./src/firebase/admin");
const initFn =
  fbAdminMod.initFirebaseAdmin ||
  fbAdminMod.initFirebase ||
  fbAdminMod.init ||
  fbAdminMod.default;

if (typeof initFn !== "function") {
  throw new Error("Firebase init inválido");
}

initFn(cfg);

// ============================
// Express
// ============================
const app = express();
app.use(express.json({ limit: "2mb" }));

const CORS_ORIGINS = (cfg.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.length === 0) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
  })
);

// ============================
// Routes
// ============================
const officeRouter = require("./src/routes/office").officeRouter;
const adminRouter = require("./src/routes/admin").adminRouter;
const { telegramRouter } = require("./src/routes/telegram");

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Office / Admin
app.use("/office", officeRouter(cfg));
app.use("/admin", adminRouter(cfg));

// 🔥 Telegram COMPLETO agora
app.use("/telegram", telegramRouter(cfg));

// ============================
// Start
// ============================
const PORT = Number(cfg.PORT || 10000);

app.listen(PORT, () => {
  console.log("✅ VeroTasks Backend online");
  console.log("→ Port:", PORT);
  console.log("→ BASE_URL:", cfg.BASE_URL || "(missing)");
  console.log("→ MASTER_CHAT_ID:", cfg.MASTER_CHAT_ID || "(missing)");
  console.log("→ AUTH_LOCK:", cfg.AUTH_LOCK === "ON" ? "ON" : "OFF");
  console.log("→ FIREBASE_ADMIN:", cfg._SERVICE_ACCOUNT_JSON ? "OK" : "MISSING");
});
