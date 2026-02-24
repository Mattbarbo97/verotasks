// backend/src/workers/telegramOfficeWatcher.js
/* eslint-disable */

module.exports = function startTelegramOfficeWatcher(cfg, deps) {
  const { getAdmin } = require("../firebase/admin");
  const { collections } = require("../firebase/collections");

  const admin = getAdmin();
  const db = admin.firestore();

  const { tgClient } = deps;
  const TASKS = collections().tasks();

  const POLL_MS = Number(process.env.OFFICE_WATCH_POLL_MS || 3000);
  const LOCK_MS = 45 * 1000;

  let timer = null;
  let running = false;

  function nowMs() {
    return Date.now();
  }

  function safeStr(v) {
    return String(v ?? "");
  }

  function isClosedStatus(s) {
    const v = String(s || "");
    return ["feito", "feito_detalhes", "deu_ruim"].includes(v);
  }

  function normalizeOfficeState(officeSignal) {
    if (!officeSignal) return "";
    if (typeof officeSignal === "string") return officeSignal;
    if (typeof officeSignal === "object" && officeSignal.state) return String(officeSignal.state);
    return "";
  }

  function signalLabel(sig) {
    if (sig === "em_andamento") return "Em andamento";
    if (sig === "preciso_ajuda") return "Precisa de ajuda";
    if (sig === "apresentou_problemas") return "Apresentou problemas";
    if (sig === "tarefa_executada") return "Tarefa executada";
    if (sig === "comentario") return "Comentado";
    return "—";
  }

  function taskPreview(t) {
    return (
      safeStr(t.message) ||
      safeStr(t.description) ||
      safeStr(t.title) ||
      safeStr(t.telegram?.rawText) ||
      safeStr(t.telegram?.text) ||
      (t.source && typeof t.source === "object" ? safeStr(t.source.text) : "") ||
      "(sem mensagem)"
    );
  }

  // ✅ HTML escape (Telegram parse_mode HTML)
  function escHtml(s) {
    return safeStr(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function buildDecisionKeyboard(taskId) {
    // Botões para o master decidir via callback_query
    return {
      inline_keyboard: [
        [
          { text: "✅ Fechar tarefa", callback_data: `decide:close:${taskId}` },
          { text: "↩️ Reabrir", callback_data: `decide:reopen:${taskId}` },
        ],
        [
          { text: "❓ Pedir detalhes", callback_data: `decide:ask:${taskId}` },
          { text: "🧾 Ver dados", callback_data: `decide:view:${taskId}` },
        ],
      ],
    };
  }

  function fmtTaskTelegramTextHTML(task) {
    const status = escHtml(task.status || "—");
    const prio = escHtml(task.priority || "media");
    const from = escHtml(task.createdBy?.name || "—");

    const sigRaw = normalizeOfficeState(task.officeSignal);
    const officeState = escHtml(signalLabel(sigRaw));

    const officeComment =
      task.officeSignal && typeof task.officeSignal === "object"
        ? escHtml(task.officeSignal.comment)
        : escHtml(task.officeComment);

    const preview = escHtml(taskPreview(task));
    const taskId = escHtml(task.id);

    const lines = [];

    if (sigRaw === "tarefa_executada") {
      lines.push(`🏢 <b>Escritório sinalizou CONCLUÍDA</b>`);
      lines.push(``);
      lines.push(`✅ A tarefa abaixo foi marcada como <b>executada</b>.`);
      lines.push(`O Master precisa decidir o próximo passo.`);
    } else {
      lines.push(`📌 <b>Sinal do Escritório</b>`);
    }

    lines.push(``);
    lines.push(`<b>Tarefa:</b> ${preview}`);
    lines.push(`<b>De:</b> ${from}`);
    lines.push(`<b>Prioridade:</b> ${prio}`);
    lines.push(`<b>Status:</b> ${status}`);
    lines.push(`<b>Sinal:</b> ${officeState}`);
    if (officeComment && officeComment !== "—") lines.push(`<b>Comentário:</b> ${officeComment}`);
    lines.push(`<b>TaskId:</b> <code>${taskId}</code>`);

    if (sigRaw === "tarefa_executada") {
      lines.push(``);
      lines.push(`👉 <b>Decida:</b> usar os botões abaixo.`);
    }

    return lines.join("\n");
  }

  async function trySendOrEditMasterMessage(task, htmlText, options = {}) {
    const masterChatId = cfg.MASTER_CHAT_ID || process.env.MASTER_CHAT_ID;
    if (!masterChatId) throw new Error("missing MASTER_CHAT_ID");

    const taskRef = TASKS.doc(task.id);
    const masterMsgId = task.telegram?.masterMessageId;

    const sendOpts = {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(options || {}),
    };

    if (masterMsgId) {
      await tgClient.editMessageText(masterChatId, masterMsgId, htmlText, sendOpts);
      return { mode: "edit", messageId: masterMsgId };
    }

    const sent = await tgClient.sendMessage(masterChatId, htmlText, sendOpts);

    const newMessageId = sent?.message_id || sent?.messageId || null;
    if (newMessageId) {
      await taskRef.set(
        {
          telegram: {
            ...(task.telegram || {}),
            masterChatId: String(masterChatId),
            masterMessageId: Number(newMessageId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
    }

    return { mode: "send", messageId: newMessageId };
  }

  async function claimTaskForProcessing(taskId) {
    const ref = TASKS.doc(taskId);
    const lockUntil = admin.firestore.Timestamp.fromMillis(nowMs() + LOCK_MS);

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error("task_not_found");
        const d = snap.data() || {};

        const lock = d.telegramOutbox?.lock || null;
        const lockMs = lock?.until?.toMillis ? lock.until.toMillis() : 0;
        if (lockMs && lockMs > nowMs()) throw new Error("locked");

        tx.set(
          ref,
          {
            telegramOutbox: {
              ...(d.telegramOutbox || {}),
              lock: { by: "office_watcher", until: lockUntil },
              lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      });

      return true;
    } catch (e) {
      if (safeStr(e?.message).includes("locked")) return false;
      return false;
    }
  }

  async function releaseLock(taskId) {
    try {
      await TASKS.doc(taskId).set(
        {
          telegramOutbox: {
            lock: null,
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {}
  }

  async function markDelivered(taskId, revision) {
    await TASKS.doc(taskId).set(
      {
        telegramOutbox: {
          deliveredRevision: Number(revision || 0),
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
          lastError: null,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  async function markFailed(taskId, errMsg) {
    await TASKS.doc(taskId).set(
      {
        telegramOutbox: {
          lastError: safeStr(errMsg).slice(0, 400),
          // mantém deliveredAt = null pra tentar novamente
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  async function fetchPendingTasks() {
    // ✅ Puxa APENAS pendentes
    // Requer que, ao sinalizar, você set:
    // telegramOutbox.kind="office_signal"
    // telegramOutbox.requestedAt=serverTimestamp()
    // telegramOutbox.deliveredAt=null
    const snap = await TASKS
      .where("telegramOutbox.kind", "==", "office_signal")
      .where("telegramOutbox.deliveredAt", "==", null)
      .orderBy("telegramOutbox.requestedAt", "asc")
      .limit(15)
      .get();

    const out = [];
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    return out;
  }

  function needsDelivery(task) {
    const rev = Number(task.telegramOutbox?.revision || 0);
    const del = Number(task.telegramOutbox?.deliveredRevision || 0);
    // deliveredAt null é o principal, mas mantemos rev/del como proteção extra:
    return Boolean(task.telegramOutbox?.deliveredAt == null) && rev > del;
  }

  async function tick() {
    if (running) return;
    running = true;

    try {
      const rows = await fetchPendingTasks();

      for (const task of rows) {
        if (!task?.id) continue;

        if (!needsDelivery(task)) continue;

        const okClaim = await claimTaskForProcessing(task.id);
        if (!okClaim) continue;

        try {
          const freshSnap = await TASKS.doc(task.id).get();
          if (!freshSnap.exists) {
            await releaseLock(task.id);
            continue;
          }

          const fresh = { id: freshSnap.id, ...freshSnap.data() };

          if (!needsDelivery(fresh)) {
            await releaseLock(task.id);
            continue;
          }

          const sigRaw = normalizeOfficeState(fresh.officeSignal);
          const htmlText = fmtTaskTelegramTextHTML(fresh);

          // ✅ Se for tarefa executada: manda com botões (para decisão do master)
          // ✅ Se já estiver fechada, ainda pode mandar o sinal (sem botões) só pra registro.
          let sendOptions = {};
          if (sigRaw === "tarefa_executada" && !isClosedStatus(fresh.status)) {
            sendOptions.reply_markup = buildDecisionKeyboard(fresh.id);
          } else {
            // se não for executada (ou já fechada), não envia botões
            sendOptions.reply_markup = undefined;
          }

          await trySendOrEditMasterMessage(fresh, htmlText, sendOptions);

          await markDelivered(fresh.id, Number(fresh.telegramOutbox?.revision || 0));
        } catch (e) {
          await markFailed(task.id, e?.message || e);
        } finally {
          await releaseLock(task.id);
        }
      }
    } catch (e) {
      console.error("[office_watcher] tick error:", e?.message || e);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    console.log("[office_watcher] starting poll:", POLL_MS, "ms");
    timer = setInterval(tick, POLL_MS);
    tick().catch(() => {});
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    console.log("[office_watcher] stopped");
  }

  return { start, stop };
};