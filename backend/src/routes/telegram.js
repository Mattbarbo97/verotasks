// backend/src/routes/telegram.js
const express = require("express");
const { createTelegramClient } = require("../telegram/client");
const { handleUpdate } = require("../telegram/webhookHandler");

function telegramRouter(cfg) {
  const router = express.Router();
  const tg = createTelegramClient(cfg);

  // Webhook do Telegram
  router.post("/webhook", async (req, res) => {
    return handleUpdate(tg, cfg, req, res);
  });

  // Set webhook
  router.post("/setWebhook", async (_, res) => {
    try {
      const url = `${cfg.BASE_URL}/telegram/webhook`;
      const { data } = await tg.post("/setWebhook", {
        url,
        secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
      });
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message });
    }
  });

  // Delete webhook
  router.post("/deleteWebhook", async (_, res) => {
    try {
      const { data } = await tg.post("/deleteWebhook", {});
      return res.json(data);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message });
    }
  });

  // 🔥 BYPASS TEMPORÁRIO — libera agora sem vínculo real
  router.post("/consume-link-token", async (_req, res) => {
    try {
      return res.json({
        ok: true,
        linked: true,
        bypass: true,
      });
    } catch (err) {
      console.error("consume-link-token bypass error:", err);
      return res.status(500).json({ ok: false });
    }
  });

  return router;
}

module.exports = { telegramRouter };
