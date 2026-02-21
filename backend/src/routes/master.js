// backend/src/routes/master.js
module.exports = function masterRouter(cfg, deps) {
  const express = require("express");
  const router = express.Router();

  const { collections } = require("../firebase/collections");
  const { nowTS } = require("../services/awaiting");

  function safeStr(v) {
    return String(v ?? "").trim();
  }

  function normalizeAction(a) {
    const s = safeStr(a).toLowerCase();

    // canon do seu app
    if (s === "feito") return "feito";
    if (s === "feito_detalhes") return "feito_detalhes";
    if (s === "deu_ruim") return "deu_ruim";
    if (s === "pendente") return "pendente";
    if (s === "comentario") return "comentario";

    // compat legado
    if (s === "concluido" || s === "concluído") return "feito";

    return "";
  }

  function isClosedStatus(status) {
    return ["feito", "feito_detalhes", "deu_ruim"].includes(String(status || ""));
  }

  function requireMasterSecret(req) {
    const got =
      req.headers["x-master-secret"] ||
      req.headers["X-Master-Secret"] ||
      req.headers["x-master-secret".toLowerCase()] ||
      "";

    const expected = String(cfg.MASTER_API_SECRET || "").trim();
    if (!expected) return { ok: false, code: 500, error: "missing_master_secret_env" };
    if (!got || String(got).trim() !== expected) return { ok: false, code: 401, error: "unauthorized" };
    return { ok: true };
  }

  async function tgSend(chatId, text, opts = {}) {
    const tg = deps?.tgClient;
    if (!tg || !chatId) return { ok: false, skipped: true };
    try {
      await tg.post("/sendMessage", { chat_id: chatId, text, ...opts });
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e?.response?.data?.description || e?.message || "telegram_error",
      };
    }
  }

  // POST /master/respond
  router.post("/respond", async (req, res) => {
    try {
      const auth = requireMasterSecret(req);
      if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });

      const { tasksCol } = collections();

      const taskId = safeStr(req.body?.taskId);
      const action = normalizeAction(req.body?.action);
      const note = safeStr(req.body?.note);
      const telegramMessageId = req.body?.telegramMessageId ?? null;

      if (!taskId) return res.status(400).json({ ok: false, error: "missing_taskId" });
      if (!action) return res.status(400).json({ ok: false, error: "invalid_action" });

      const ref = tasksCol.doc(taskId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: "task_not_found" });

      const cur = snap.data() || {};
      const prevStatus = String(cur.status || "aberta");

      const masterBy = {
        source: "telegram_master",
        chatId: String(cfg.MASTER_CHAT_ID || ""),
      };

      // patch base
      const patch = {
        updatedAt: nowTS(),
        masterActionAt: nowTS(),
        masterAction: action,
        masterBy,
        masterTelegramMessageId: telegramMessageId,
      };

      if (action === "comentario") {
        patch.masterComment = note || "";
      } else if (action === "pendente") {
        patch.status = "pendente";
        if (note) patch.masterComment = note;
      } else if (action === "feito") {
        patch.status = "feito";
        if (note) patch.details = note;
        patch.closedAt = nowTS();
        patch.closedBy = masterBy;
        patch.officeSignalLock = true;
        patch.officeSignalLockedAt = nowTS();
        patch.officeSignalLockedBy = "master";
      } else if (action === "feito_detalhes") {
        patch.status = "feito_detalhes";
        if (note) patch.details = note;
        patch.closedAt = nowTS();
        patch.closedBy = masterBy;
        patch.officeSignalLock = true;
        patch.officeSignalLockedAt = nowTS();
        patch.officeSignalLockedBy = "master";
      } else if (action === "deu_ruim") {
        patch.status = "deu_ruim";
        patch.details = note || cur.details || "🚫 Deu ruim (sem detalhes)";
        patch.closedAt = nowTS();
        patch.closedBy = masterBy;
        patch.officeSignalLock = true;
        patch.officeSignalLockedAt = nowTS();
        patch.officeSignalLockedBy = "master";
      }

      await ref.set(patch, { merge: true });

      // opcional: notificar o escritório
      const officeChatId = String(cfg.OFFICE_CHAT_ID || "").trim();
      let officeNotify = { ok: false, skipped: true };

      if (officeChatId) {
        const title =
          safeStr(cur.title) ||
          safeStr(cur.message) ||
          safeStr(cur.description) ||
          safeStr(cur.telegram?.cleanText) ||
          safeStr(cur.telegram?.rawText) ||
          "—";

        const msg =
          `📣 *Master atualizou a tarefa*\n` +
          `• ID: \`${taskId}\`\n` +
          `• Ação: *${action}*\n` +
          `• Status: *${patch.status || prevStatus}*\n` +
          `• Tarefa: ${safeStr(title).slice(0, 140)}\n` +
          (note ? `\n💬 ${safeStr(note).slice(0, 900)}\n` : "");

        officeNotify = await tgSend(officeChatId, msg, { parse_mode: "Markdown" });
      }

      return res.json({
        ok: true,
        taskId,
        action,
        status: patch.status || prevStatus,
        closed: isClosedStatus(patch.status || prevStatus),
        officeNotify,
      });
    } catch (e) {
      console.error("[master/respond] error:", e);
      return res.status(500).json({ ok: false, error: e?.message || "server_error" });
    }
  });

  return router;
};
