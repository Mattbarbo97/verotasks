// src/routes/admin.js
const express = require("express");
const { requireAdminAuth } = require("../middlewares/requireSecrets");
const { getAdmin } = require("../firebase/admin");
const { collections } = require("../firebase/collections");
const { nowTS } = require("../services/awaiting");

function adminRouter(cfg) {
  const router = express.Router();
  const admin = getAdmin();
  const { usersCol } = collections();

  router.post("/createUser", requireAdminAuth(cfg), async (req, res) => {
    try {
      const { email, password, name, role = "office", active = true } = req.body || {};
      const emailStr = String(email || "").trim().toLowerCase();
      const passStr = String(password || "");

      if (!emailStr || !passStr) {
        return res.status(400).json({ ok: false, error: "missing_email_or_password" });
      }
      if (passStr.length < 6) {
        return res.status(400).json({ ok: false, error: "password_too_short" });
      }

      const displayName = name ? String(name).slice(0, 80) : emailStr.split("@")[0];

      const user = await admin.auth().createUser({
        email: emailStr,
        password: passStr,
        displayName,
      });

      await admin.auth().setCustomUserClaims(user.uid, { role });

      await usersCol.doc(user.uid).set(
        {
          uid: user.uid,
          email: user.email,
          name: displayName,
          role: String(role || "office"),
          status: active ? "active" : "disabled",
          createdAt: nowTS(),

          telegramUserId: null,
          telegramChatId: null,
          telegramLinkedAt: null,
          telegramLabel: null,
        },
        { merge: true }
      );

      return res.json({ ok: true, uid: user.uid, email: user.email, role });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("email-already-exists")) {
        return res.status(409).json({ ok: false, error: "email_exists" });
      }
      console.error("admin/createUser error:", msg);
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}

module.exports = { adminRouter };
