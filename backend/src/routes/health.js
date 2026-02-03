// src/routes/health.js
const express = require("express");
const { collections } = require("../firebase/collections");
const { nowTS } = require("../services/awaiting");

function healthRouter(cfg) {
  const router = express.Router();
  const { db } = collections();

  router.get("/", (_, res) => res.status(200).send("ok"));

  router.get("/health", async (_, res) => {
    try {
      await db.collection("_health").doc("ping").set({ at: nowTS() }, { merge: true });
      res.json({
        ok: true,
        service: "verotasks-backend",
        now: new Date().toISOString(),
        authLock: true,
        baseUrl: cfg.BASE_URL,
        hasOfficeChat: !!cfg.OFFICE_CHAT_ID,
        mode: cfg.MODE,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return router;
}

module.exports = { healthRouter };
