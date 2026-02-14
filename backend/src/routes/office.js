// backend/src/routes/office.js

module.exports = function officeRouter(cfg, deps) {
  const express = require("express");
  const { requireOfficeAuth } = require("../middlewares/requireSecrets");
  const { collections } = require("../firebase/collections");
  const { getAdmin } = require("../firebase/admin");
  const { nowTS } = require("../services/awaiting");
  const { createUniqueLinkTokenDoc } = require("../services/linkTokens");
  const { isUserAllowed } = require("../services/telegramAuth");

  // ✅ AGORA USA O CLIENT CORRETO DO index.js
  const { tgClient } = deps;

  const { safeStr } = require("../telegram/helpers");
  const { isClosedStatus } = require("../telegram/text");
  const {
    notifyMasterAboutOfficeSignal,
    refreshOfficeCard,
  } = require("../services/tasks");

  function FieldValue() {
    return getAdmin().firestore.FieldValue;
  }

  /**
   * Wrapper compatível com services/tasks
   */
  function createTgApi() {
    return {
      sendMessage: async (chatId, text, opts = {}) => {
        const payload = {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          ...opts,
        };
        const { data } = await tgClient.post("/sendMessage", payload);
        if (!data?.ok) {
          throw new Error(
            `sendMessage failed: ${JSON.stringify(data)}`
          );
        }
        return data.result;
      },

      editMessage: async (chatId, messageId, text, opts = {}) => {
        const payload = {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          ...opts,
        };
        const { data } = await tgClient.post(
          "/editMessageText",
          payload
        );
        if (!data?.ok) {
          throw new Error(
            `editMessageText failed: ${JSON.stringify(data)}`
          );
        }
        return data.result;
      },
    };
  }

  const router = express.Router();
  const tgApi = createTgApi();
  const { usersCol, tasksCol } = collections();

  /**
   * =========================================================
   * LINK TOKEN
   * =========================================================
   */
  router.post(
    "/link-token",
    requireOfficeAuth(cfg),
    async (req, res) => {
      try {
        const { uid, email } = req.body || {};
        const uidStr = String(uid || "").trim();
        const emailStr = String(email || "")
          .trim()
          .toLowerCase();

        if (!uidStr || !emailStr) {
          return res
            .status(400)
            .json({ ok: false, error: "missing_uid_or_email" });
        }

        const userRef = usersCol.doc(uidStr);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          return res
            .status(404)
            .json({ ok: false, error: "user_not_found" });
        }

        const user = userSnap.data() || {};
        if (!isUserAllowed(user)) {
          return res
            .status(403)
            .json({ ok: false, error: "user_not_allowed" });
        }

        const storedEmail = String(user.email || "")
          .toLowerCase();

        if (storedEmail && storedEmail !== emailStr) {
          return res
            .status(403)
            .json({ ok: false, error: "email_mismatch" });
        }

        const { token, expiresAt, ttlMin } =
          await createUniqueLinkTokenDoc({
            uid: uidStr,
            email: emailStr,
            ttlMin: 10,
          });

        return res.json({
          ok: true,
          token,
          ttlMin,
          expiresAt: expiresAt?.toDate
            ? expiresAt.toDate().toISOString()
            : null,
        });
      } catch (e) {
        console.error("office/link-token error:", e);
        return res
          .status(500)
          .json({ ok: false, error: "server_error" });
      }
    }
  );

  /**
   * =========================================================
   * OFFICE SIGNAL
   * =========================================================
   */
  router.post(
    "/signal",
    requireOfficeAuth(cfg),
    async (req, res) => {
      const reqId = `sig_${Date.now()
        .toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 7)}`;

      try {
        const {
          taskId,
          state,
          comment = "",
          by = null,
        } = req.body || {};

        const taskIdStr = String(taskId || "").trim();
        const stateStr = String(state || "").trim();
        const commentStr = String(comment || "").slice(
          0,
          2000
        );

        if (!taskIdStr || !stateStr) {
          return res.status(400).json({
            ok: false,
            error: "missing_taskId_or_state",
          });
        }

        const allowedStates = new Set([
          "em_andamento",
          "preciso_ajuda",
          "apresentou_problemas",
          "tarefa_executada",
          "comentario",
        ]);

        if (!allowedStates.has(stateStr)) {
          return res
            .status(400)
            .json({ ok: false, error: "invalid_state" });
        }

        const byEmail = safeStr(
          by?.email || "office-web"
        );
        const byUid = safeStr(by?.uid || "office-web");

        const ref = tasksCol.doc(taskIdStr);
        const snap = await ref.get();
        if (!snap.exists) {
          return res
            .status(404)
            .json({ ok: false, error: "task_not_found" });
        }

        const t = snap.data() || {};

        if (isClosedStatus(t.status)) {
          return res
            .status(409)
            .json({ ok: false, error: "task_closed" });
        }

        // 1️⃣ SALVA SEMPRE
        await ref.update({
          officeSignal: {
            state: stateStr,
            comment: commentStr,
            updatedAt: nowTS(),
            updatedBy: {
              uid: byUid,
              email: byEmail,
            },
          },
          officeComment: commentStr,
          officeSignaledAt: nowTS(),
          updatedAt: nowTS(),
          audit: FieldValue().arrayUnion({
            at: nowTS(),
            by: {
              userId: byUid,
              name: byEmail,
            },
            action: "office_signal",
            meta: {
              state: stateStr,
              hasComment: !!commentStr,
              reqId,
            },
          }),
        });

        const updated = (
          await ref.get()
        ).data() || {};

        // 2️⃣ NOTIFICA MASTER (SEM QUEBRAR HTTP)
        let notified = true;

        try {
          await notifyMasterAboutOfficeSignal(
            tgApi,
            cfg,
            {
              taskId: taskIdStr,
              t: updated,
              state: stateStr,
              comment: commentStr,
              byEmail,
              reqId,
            }
          );
        } catch (err) {
          notified = false;
          console.error(
            `[office/signal][${reqId}] notify failed:`,
            err
          );
        }

        // 3️⃣ REFRESH CARD (BEST EFFORT)
        try {
          await refreshOfficeCard(
            tgApi,
            taskIdStr
          );
        } catch (_) {}

        return res.json({
          ok: true,
          saved: true,
          notified,
          reqId,
        });
      } catch (e) {
        console.error(
          `[office/signal][${reqId}] error:`,
          e
        );
        return res.status(500).json({
          ok: false,
          error: "server_error",
          reqId,
        });
      }
    }
  );

  return router;
};
  