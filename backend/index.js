// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

require("./src/firebase/admin");

// Telegram (handler + client axios)
const { handleUpdate } = require("./src/telegram/webhookHandler");
const tgClient = require("./src/telegram/client");

// ✅ helper: aceita exports em vários formatos
function pickRouter(mod) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;

  // formatos comuns
  return (
    mod.router ||
    mod.officeRouter ||
    mod.adminRouter ||
    mod.telegramRouter ||
    mod.default ||
    null
  );
}

// Routes (podem exportar router direto OU dentro de objeto)
const officeRouter = pickRouter(require("./src/routes/office"));
const adminRouter = pickRouter(require("./src/routes/admin"));

const app = express();
app.use(express.json({ limit: "2mb" }));

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.length === 0) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  })
);

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ✅ valida routers antes de usar (pra log claro)
if (!officeRouter) throw new Error("officeRouter inválido: export não é router middleware");
if (!adminRouter) throw new Error("adminRouter inválido: export não é router middleware");

// Office API
app.use("/office", officeRouter);

// Admin API
app.use("/admin", adminRouter);

// Telegram webhook
app.post("/telegram/webhook", (req, res) => {
  return handleUpdate(tgClient, process.env, req, res);
});

app.get("/telegram", (req, res) => {
  res.json({ ok: true, route: "telegram", ts: new Date().toISOString() });
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log("✅ VeroTasks Backend online");
  console.log("→ Port:", PORT);
  console.log("→ BASE_URL:", process.env.BASE_URL || "(missing)");
  console.log("→ OFFICE_CHAT_ID:", process.env.OFFICE_CHAT_ID ? "(set)" : "(mesmo chat do solicitante)");
  console.log("→ MASTER_CHAT_ID:", process.env.MASTER_CHAT_ID || "(missing)");
  console.log("→ MODE:", process.env.MODE || "master_only_finalize");
  console.log("→ AUTH_LOCK:", process.env.AUTH_LOCK === "ON" ? "ON" : "OFF");
});
