// backend/src/routes/office.js
const express = require("express");
const { requireOfficeAuth } = require("../middlewares/requireSecrets");
const { collections } = require("../firebase/collections");
const { getAdmin } = require("../firebase/admin");
const { see } = require("../services/awaiting"); // (não usado, pode remover se quiser)
const { nowTS } = require("../services/awaiting");
const { createUniqueLinkTokenDoc } = require("../services/linkTokens");
const { isUserAllowed } = require("../services/telegramAuth");

const tgClient = require("../telegram/client"); // axios client
const { safeStr } = require("../telegram/helpers");
const { isClosedStatus } = require("../telegram/text");
const { notifyMasterAboutOfficeSignal, refreshOfficeCard } = require("../services/tasks");

function FieldValue() {
  return getAdmin().firestore.FieldValue;
}

/**
 * Mini wrapper compatível com services/tasks
 * (usa axios client do Telegram)
 */
function createTgApi() {
  return {
    sendMessage: async (chatId, text, opts = {}) => {
      const payload = { chat_id: chatId, text, parse_mode: "HTML", ...opts };
      const { data } = await tgClient.post("/sendMessage", payload);
      if (!data?.ok) throw new Error(`sendMessage failed: ${JSON.stringify(data)}`);
      return data.result;
    },
    editMessage: async (chatId, messageId, text, opts = {}) => {
      const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...opts };
      const { data } = await tgClient.post("/editMessageText", payload);
      if (!data?.ok) throw new Error(`editMessageText failed: ${JSON.stringify(data)}`);
      return data.result;
    },
  };
}

function buildCfgFromEnv(env) {
  // ✅ fonte de verdade mínima e explícita (evita undefined silencioso)
  return {
    MASTER_CHAT_ID: String(env.MASTER_CHAT_ID || "").trim(),
    OFFICE_CHAT_ID: String(env.OFFICE_CHAT_ID || "").trim(),
    MODE: String(env.MODE || "master_only_finalize").trim(),
    AUTH_LOCK: String(env.AUTH_LOCK || "OFF").trim(),
  };
}

const router = express.Router();
const tgApi = createTgApi();

const { usersCol, tasksCol } = collections();

/**
 * ✅ Gerar token p/ vincular Telegram
 * POST /office/link-token
 * body: { uid, email }
 */
router.post("/link-token", requireOfficeAuth(process.env), async (req, res) => {
  try {
    const { uid, email } = req.body || {};
    const uidStr = String(uid || "").trim();
    const emailStr = String(email || "").trim().toLowerCase();

    if (!uidStr || !emailStr) {
      return res.status(400).json({ ok: false, error: "missing_uid_or_email" });
    }

    const userRef = usersCol.doc(uidStr);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const user = userSnap.data() || {};
    if (!isUserAllowed(user)) {
      return res.status(403).json({ ok: false, error: "user_not_allowed" });
    }

    const storedEmail = String(user.email || "").toLowerCase();
    if (storedEmail && storedEmail !== emailStr) {
      return res.status(403).json({ ok: false, error: "email_mismatch" });
    }

    const { token, expiresAt, ttlMin } = await createUniqueLinkTokenDoc({
      uid: uidStr,
      email: emailStr,
      ttlMin: 10,
    });

    return res.json({
      ok: true,
      token,
      ttlMin,
      expiresAt: expiresAt?.toDate ? expiresAt.toDate().toISOString() : null,
    });
  } catch (e) {
    console.error("office/link-token error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * ✅ Signal task (Office -> Master)
 * POST /office/signal
 * body: { taskId, state, comment?, by? {uid,email} }
 */
router.post("/signal", requireOfficeAuth(process.env), async (req, res) => {
  const reqId = `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  try {
    const { taskId, state, comment = "", by = null } = req.body || {};
    const taskIdStr = String(taskId || "").trim();
    const stateStr = String(state || "").trim();
    const commentStr = String(comment || "").slice(0, 2000);

    if (!taskIdStr || !stateStr) {
      return res.status(400).json({ ok: false, error: "missing_taskId_or_state" });
    }

    const allowedStates = new Set([
      "em_andamento",
      "preciso_ajuda",
      "apresentou_problemas",
      "tarefa_executada",
      "comentario",
    ]);
    if (!allowedStates.has(stateStr)) {
      return res.status(400).json({ ok: false, error: "invalid_state" });
    }

    const byEmail = safeStr(by?.email || "office-web");
    const byUid = safeStr(by?.uid || "office-web");

    const ref = tasksCol.doc(taskIdStr);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "task_not_found" });

    const t = snap.data() || {};
    if (isClosedStatus(t.status)) {
      return res.status(409).json({ ok: false, error: "task_closed" });
    }

    // ✅ 1) salva SEMPRE
    await ref.update({
      officeSignal: {
        state: stateStr,
        comment: commentStr,
        updatedAt: nowTS(),
        updatedBy: { uid: byUid, email: byEmail },
      },
      officeComment: commentStr,
      officeSignaledAt: nowTS(),
      updatedAt: nowTS(),
      audit: FieldValue().arrayUnion({
        at: nowTS(),
        by: { userId: byUid, name: byEmail },
        action: "office_signal",
        meta: { state: stateStr, hasComment: !!commentStr, reqId },
      }),
    });

    const updated = (await ref.get()).data() || {};

    const toast =
      stateStr === "comentario"
        ? "💬 Comentário enviado ao Master."
        : stateStr === "tarefa_executada"
        ? "✅ Informado ao Master: tarefa executada."
        : stateStr === "apresentou_problemas"
        ? "🚫 Informado ao Master: apresentou problemas."
        : stateStr === "preciso_ajuda"
        ? "🆘 Pedido de ajuda enviado ao Master."
        : "🛠️ Em andamento — Master notificado.";

    // ✅ 2) tenta notificar (mas NÃO pode quebrar o HTTP)
    const cfg = buildCfgFromEnv(process.env);

    if (!cfg.MASTER_CHAT_ID) {
      console.error(`[office/signal][${reqId}] MASTER_CHAT_ID missing`);
    }

    let notified = true;
    let notifyError = null;

    try {
      await notifyMasterAboutOfficeSignal(tgApi, cfg, {
        taskId: taskIdStr,
        t: updated,
        state: stateStr,
        comment: commentStr,
        byEmail,
        reqId,
      });
    } catch (err) {
      notified = false;
      notifyError = String(err?.message || err || "").slice(0, 220);
      console.error(`[office/signal][${reqId}] notifyMaster failed:`, err);

      try {
        await ref.update({
          officeSignalNotify: {
            ok: false,
            error: notifyError,
            at: nowTS(),
            reqId,
          },
          updatedAt: nowTS(),
        });
      } catch (_) {}
    }

    // ✅ 3) refresh do card (best effort)
    try {
      await refreshOfficeCard(tgApi, taskIdStr);
    } catch (_) {}

    // ✅ 4) resposta SEMPRE 200 quando salvou
    if (!notified) {
      return res.json({
        ok: true,
        saved: true,
        notified: false,
        toast: "⚠️ Sinal salvo, mas não consegui avisar o Master (Telegram).",
        reqId,
      });
    }

    return res.json({ ok: true, saved: true, notified: true, toast, reqId });
  } catch (e) {
    console.error(`[office/signal][${reqId}] error:`, e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      reqId,
      detail: String(e?.message || e || "").slice(0, 180),
    });
  }
});

module.exports = router;
