// src/routes/telegram.js
const express = require("express");
const { createTelegramClient } = require("../telegram/client");
const { handleUpdate } = require("../telegram/webhookHandler");

function telegramRouter(cfg) {
  const router = express.Router();
  const tg = createTelegramClient(cfg);

  router.post("/webhook", async (req, res) => {
    return handleUpdate(tg, cfg, req, res);
  });

  router.post("/setWebhook", async (_, res) => {
    try {
      const url = `${cfg.BASE_URL}/telegram/webhook`;
      const { data } = await tg.post("/setWebhook", {
        url,
        secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message });
    }
  });

  router.post("/deleteWebhook", async (_, res) => {
    try {
      const { data } = await tg.post("/deleteWebhook", {});
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message });
    }
  });

  return router;
}

module.exports = { telegramRouter };
