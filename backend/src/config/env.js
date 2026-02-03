// src/config/env.js
function must(v, name) {
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function loadEnv(env) {
  const cfg = {
    TELEGRAM_BOT_TOKEN: must(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
    TELEGRAM_WEBHOOK_SECRET: must(env.TELEGRAM_WEBHOOK_SECRET, "TELEGRAM_WEBHOOK_SECRET"),
    BASE_URL: must(env.BASE_URL, "BASE_URL"),
    FIREBASE_SERVICE_ACCOUNT: must(env.FIREBASE_SERVICE_ACCOUNT, "FIREBASE_SERVICE_ACCOUNT"),
    MASTER_CHAT_ID: must(env.MASTER_CHAT_ID, "MASTER_CHAT_ID"),
    OFFICE_API_SECRET: must(env.OFFICE_API_SECRET, "OFFICE_API_SECRET"),
    ADMIN_API_SECRET: must(env.ADMIN_API_SECRET, "ADMIN_API_SECRET"),

    OFFICE_CHAT_ID: env.OFFICE_CHAT_ID || "",
    CORS_ORIGINS: env.CORS_ORIGINS || "",
    PORT: env.PORT || "",
    MODE: String(env.MODE || "master_only_finalize").trim(),
  };

  // parse JSON do service account só aqui (fail fast)
  try {
    cfg._SERVICE_ACCOUNT_JSON = JSON.parse(cfg.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
  }

  return cfg;
}

module.exports = { loadEnv };
