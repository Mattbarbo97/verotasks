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

  // JSON puro
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = JSON.parse(s);
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  }

  // base64(JSON)
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

// telegram.js exporta: module.exports = { telegramRouter }
// ⚠️ IMPORTANTE: passe deps se o telegram router usa tgClient internamente
const { telegramRouter } = require("./src/routes/telegram");

// master.js exporta: module.exports = function masterRouter(cfg, deps)
const masterRouter = require("./src/routes/master");

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Office
app.use("/office", officeRouter(cfg, deps));

// Master (finaliza pelo Telegram)
app.use("/master", masterRouter(cfg, deps));

// Admin
app.use("/admin", adminRouter(cfg));

// Telegram (webhook + consume-link-token)
app.use("/telegram", telegramRouter(cfg, deps)); // ✅ antes estava sem deps

// ============================
// Worker: Firestore -> Telegram (office outbox)
// ============================
const startTelegramOfficeWatcher = require("./src/workers/telegramOfficeWatcher");
let officeWatcher = null;

// ============================
// Start
// ============================
const PORT = Number(cfg.PORT || 10000);

const server = app.listen(PORT, () => {
  console.log("✅ VeroTasks Backend online");
  console.log("→ Port:", PORT);
  console.log("→ BASE_URL:", cfg.BASE_URL || "(missing)");
  console.log("→ MASTER_CHAT_ID:", cfg.MASTER_CHAT_ID || "(missing)");
  console.log("→ OFFICE_CHAT_ID:", cfg.OFFICE_CHAT_ID || "(missing)");
  console.log("→ AUTH_LOCK:", cfg.AUTH_LOCK === "ON" ? "ON" : "OFF");
  console.log("→ FIREBASE_ADMIN:", cfg._SERVICE_ACCOUNT_JSON ? "OK" : "MISSING");

  // ✅ inicia watcher
  try {
    officeWatcher = startTelegramOfficeWatcher(cfg, deps);
    if (officeWatcher && typeof officeWatcher.start === "function") {
      officeWatcher.start();
      console.log("✅ telegramOfficeWatcher started");
    } else {
      console.log("⚠️ telegramOfficeWatcher inválido (sem start())");
    }
  } catch (e) {
    console.error("❌ falha ao iniciar telegramOfficeWatcher:", e?.message || e);
  }
});

// ============================
// Graceful shutdown
// ============================
function shutdown(signal) {
  console.log(`🛑 shutdown (${signal})`);

  try {
    if (officeWatcher && typeof officeWatcher.stop === "function") {
      officeWatcher.stop();
      console.log("→ watcher stopped");
    }
  } catch (e) {
    console.error("→ watcher stop error:", e?.message || e);
  }

  try {
    server.close(() => {
      console.log("→ http server closed");
      process.exit(0);
    });

    // força saída se travar
    setTimeout(() => process.exit(1), 8000).unref();
  } catch (e) {
    console.error("→ shutdown error:", e?.message || e);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));