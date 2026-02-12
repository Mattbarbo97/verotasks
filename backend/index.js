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

  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = JSON.parse(s);
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  }

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

const cfg = buildCfgFromEnv(process.env);

// ============================
// Firebase Admin
// ============================
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
// Telegram Client (deps)
// ============================
const { createTelegramClient } = require("./src/telegram/client");
const tgClient = createTelegramClient(cfg);
const deps = { tgClient };

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

// office.js exporta: module.exports = function officeRouter(cfg, deps)
const officeRouter = require("./src/routes/office");

// admin.js exporta: module.exports = { adminRouter }
const { adminRouter } = require("./src/routes/admin");

// telegram.js precisa exportar: module.exports = { telegramRouter }
const { telegramRouter } = require("./src/routes/telegram");

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Office
app.use("/office", officeRouter(cfg, deps));

// Admin
app.use("/admin", adminRouter(cfg));

// Telegram (webhook + consume-link-token)
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
