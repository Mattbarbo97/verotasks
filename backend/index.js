// index.js (NEW) — VeroTasks Backend (refatorado)
require("dotenv").config();

const express = require("express");

const { loadEnv } = require("./src/config/env");
const { corsMiddleware } = require("./src/middlewares/cors");
const { initFirebase } = require("./src/firebase/admin");

const { healthRouter } = require("./src/routes/health");
const { telegramRouter } = require("./src/routes/telegram");
const { officeRouter } = require("./src/routes/office");
const { adminRouter } = require("./src/routes/admin");

// 1) valida env + carrega config
const cfg = loadEnv(process.env);

// 2) init firebase admin
initFirebase(cfg);

// 3) express
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(corsMiddleware(cfg));

// 4) routes
app.use("/", healthRouter(cfg));
app.use("/telegram", telegramRouter(cfg));
app.use("/office", officeRouter(cfg));
app.use("/admin", adminRouter(cfg));

// 5) boot
const listenPort = Number(cfg.PORT || 8080);
app.listen(listenPort, () => {
  console.log("✅ VeroTasks Backend online");
  console.log(`→ Port: ${listenPort}`);
  console.log(`→ BASE_URL: ${cfg.BASE_URL}`);
  console.log(`→ OFFICE_CHAT_ID: ${cfg.OFFICE_CHAT_ID || "(mesmo chat do solicitante)"}`);
  console.log(`→ MASTER_CHAT_ID: ${cfg.MASTER_CHAT_ID}`);
  console.log(`→ MODE: ${cfg.MODE}`);
  console.log("→ AUTH_LOCK: ON (requires /link + chat match + role/status)");
});
