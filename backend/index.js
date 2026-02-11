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

  // Base64 (caso tenha salvo assim)
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
// Router loader (aceita export em vários formatos)
// ============================
function pickExport(mod) {
  if (!mod) return null;

  // se exportou router direto:
  if (typeof mod === "function") return mod;

  // se exportou { router } / { officeRouter } etc:
  return mod.router || mod.officeRouter || mod.adminRouter || mod.default || null;
}

// ============================
// Boot (Firebase + Telegram client)
// ============================
const cfg = buildCfgFromEnv(process.env);

// ✅ inicializa Firebase Admin ANTES de qualquer rota/collection
const fbAdminMod = require("./src/firebase/admin");

// tenta suportar vários nomes de export pra evitar quebra
const initFn =
  fbAdminMod.initFirebaseAdmin ||
  fbAdminMod.initFirebase ||
  fbAdminMod.init ||
  fbAdminMod.default;

if (typeof initFn !== "function") {
  throw new Error(
    "Firebase init inválido: ./src/firebase/admin não exporta initFirebaseAdmin/initFirebase/init/default"
  );
}

// chama com cfg (se sua função não aceita param, JS ignora)
initFn(cfg);

// Telegram
const { createTelegramClient } = require("./src/telegram/client");
const { handleUpdate } = require("./src/telegram/webhookHandler");
const tgClient = createTelegramClient(cfg);

// Routes
const officeMod = require("./src/routes/office");
const adminMod = require("./src/routes/admin");

const officeFactoryOrRouter = pickExport(officeMod);
const adminFactoryOrRouter = pickExport(adminMod);

const officeRouter =
  typeof officeFactoryOrRouter === "function"
    ? officeFactoryOrRouter(cfg)
    : officeFactoryOrRouter;

const adminRouter =
  typeof adminFactoryOrRouter === "function"
    ? adminFactoryOrRouter(cfg)
    : adminFactoryOrRouter;

if (!officeRouter) throw new Error("officeRouter inválido: export não é router/factory");
if (!adminRouter) throw new Error("adminRouter inválido: export não é router/factory");

// ============================
// Express app
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

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Office API
app.use("/office", officeRouter);

// Admin API
app.use("/admin", adminRouter);

// Telegram webhook
app.post("/telegram/webhook", (req, res) => {
  return handleUpdate(tgClient, cfg, req, res);
});

app.get("/telegram", (req, res) => {
  res.json({ ok: true, route: "telegram", ts: new Date().toISOString() });
});

const PORT = Number(cfg.PORT || 10000);
app.listen(PORT, () => {
  console.log("✅ VeroTasks Backend online");
  console.log("→ Port:", PORT);
  console.log("→ BASE_URL:", cfg.BASE_URL || "(missing)");
  console.log("→ OFFICE_CHAT_ID:", cfg.OFFICE_CHAT_ID ? "(set)" : "(mesmo chat do solicitante)");
  console.log("→ MASTER_CHAT_ID:", cfg.MASTER_CHAT_ID || "(missing)");
  console.log("→ MODE:", cfg.MODE || "master_only_finalize");
  console.log("→ AUTH_LOCK:", cfg.AUTH_LOCK === "ON" ? "ON" : "OFF");
  console.log("→ FIREBASE_ADMIN:", cfg._SERVICE_ACCOUNT_JSON ? "OK" : "MISSING");
});
