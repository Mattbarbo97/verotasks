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
  // se exportou objeto
  return mod.router || mod.officeRouter || mod.adminRouter || mod.default || mod;
}

// ============================
// Validação profunda: detecta handlers undefined
// ============================
function assertRouterValid(router, name) {
  if (!router) throw new Error(`${name}: router é null/undefined`);

  // Router do Express é uma função middleware + tem stack
  const stack = router.stack;
  if (!Array.isArray(stack)) {
    // ainda pode ser middleware puro
    if (typeof router !== "function") {
      throw new Error(`${name}: não é function e não tem stack`);
    }
    return;
  }

  for (const layer of stack) {
    // layer.route -> endpoints (get/post/etc)
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

    // router.use(...) (middlewares)
    if (!layer || typeof layer.handle !== "function") {
      throw new Error(`${name}: middleware inválido (router.use com handler undefined?)`);
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
  throw new Error(
    "Firebase init inválido: ./src/firebase/admin não exporta initFirebaseAdmin/initFirebase/init/default"
  );
}

initFn(cfg);

// ✅ Telegram
const { createTelegramClient } = require("./src/telegram/client");
const { handleUpdate } = require("./src/telegram/webhookHandler");
const tgClient = createTelegramClient(cfg);

// deps que rotas podem precisar
const deps = { tgClient };

// ============================
// Routes (factory(cfg, deps) OU router pronto)
// ============================
function buildRouter(modPath, name) {
  const mod = require(modPath);
  const exp = pickExport(mod);

  // 1) Se exportou função "factory", chama com (cfg, deps)
  if (typeof exp === "function" && exp.stack === undefined) {
    // factory normal (não é router express)
    const out =
      exp.length >= 2 ? exp(cfg, deps) : exp(cfg); // se aceitar deps, passa
    assertRouterValid(out, name);
    return out;
  }

  // 2) Se exportou router (tem stack)
  if (exp && (typeof exp === "function" || typeof exp === "object")) {
    assertRouterValid(exp, name);
    return exp;
  }

  throw new Error(`${name}: export inválido`);
}

const officeRouter = buildRouter("./src/routes/office", "officeRouter");
const adminRouter = buildRouter("./src/routes/admin", "adminRouter");

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

// Office/Admin
app.use("/office", officeRouter);
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
  console.log("→ MASTER_CHAT_ID:", cfg.MASTER_CHAT_ID || "(missing)");
  console.log("→ AUTH_LOCK:", cfg.AUTH_LOCK === "ON" ? "ON" : "OFF");
  console.log("→ FIREBASE_ADMIN:", cfg._SERVICE_ACCOUNT_JSON ? "OK" : "MISSING");
});
