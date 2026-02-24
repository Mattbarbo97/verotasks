// backend/src/telegram/webhookHandler.js
const { collections } = require("../firebase/collections");
const { nowTS } = require("../services/awaiting");

// =========================================================
// Utils
// =========================================================
function safeText(v) {
  return String(v || "").trim();
}

function isAuthLockOn(cfg) {
  return String(cfg.AUTH_LOCK || "").toUpperCase() === "ON";
}

async function tgSend(tg, chatId, text, opts = {}) {
  if (!chatId) return null;
  return tg.post("/sendMessage", { chat_id: chatId, text, ...opts });
}

async function tgEdit(tg, chatId, messageId, text, opts = {}) {
  if (!chatId || !messageId) return null;
  return tg.post("/editMessageText", { chat_id: chatId, message_id: messageId, text, ...opts });
}

async function tgAnswerCallback(tg, callbackQueryId, text = "", showAlert = false) {
  if (!callbackQueryId) return null;
  return tg.post("/answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: !!showAlert,
  });
}

function fmtUserLabel(msg) {
  const u = msg?.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  const user = u.username ? `@${u.username}` : "";
  const id = u.id ? `id:${u.id}` : "";
  return [name || user || id || "desconhecido", user, id].filter(Boolean).join(" | ");
}

function normalizePriority(p) {
  const s = String(p || "").toLowerCase().trim();
  if (["baixa", "low"].includes(s)) return "baixa";
  if (["media", "média", "normal", "medium"].includes(s)) return "media";
  if (["alta", "high"].includes(s)) return "alta";
  if (["urgente", "critica", "crítica", "critical", "urgent"].includes(s)) return "urgente";
  return "media";
}

function priorityBadge(p) {
  const pr = normalizePriority(p);
  if (pr === "urgente") return "🔴 URGENTE";
  if (pr === "alta") return "🟠 ALTA";
  if (pr === "baixa") return "🟢 BAIXA";
  return "🟡 MÉDIA";
}

function parsePriorityFromCommand(rawText) {
  const t = safeText(rawText);
  if (!t) return { priority: null, cleanText: "" };

  const lines = t.split("\n");
  const first = safeText(lines[0]);

  const m1 = first.match(
    /^\/(?:p|prioridade)\s+(baixa|media|m[eé]dia|alta|urgente|critica|cr[ií]tica)\s*$/i
  );
  if (m1) {
    const pr = normalizePriority(m1[1]);
    const cleanText = safeText(lines.slice(1).join("\n"));
    return { priority: pr, cleanText };
  }

  const m2 = t.match(
    /^\/(?:p|prioridade)\s+(baixa|media|m[eé]dia|alta|urgente|critica|cr[ií]tica)\s+([\s\S]+)$/i
  );
  if (m2) {
    const pr = normalizePriority(m2[1]);
    const cleanText = safeText(m2[2]);
    return { priority: pr, cleanText };
  }

  return { priority: null, cleanText: t };
}

function detectPriorityFromText(text) {
  const t = safeText(text).toLowerCase();
  if (!t) return "media";

  if (/(urgente|cr[ií]tico|critico|cr[ií]tica|emerg[eê]ncia|emergencia|parou|travou|fora do ar)/.test(t)) {
    return "urgente";
  }
  if (/(prioridade\s*alta|alta\s*prioridade|importante|hoje|agora)/.test(t)) {
    return "alta";
  }
  if (/(sem pressa|quando der|baixa prioridade|depois)/.test(t)) {
    return "baixa";
  }
  return "media";
}

function buildTitle(text) {
  const t = safeText(text);
  if (!t) return "Solicitação via Telegram";
  return t.replace(/\s+/g, " ").slice(0, 80);
}

// rate-limit simples
const RL = new Map();
function hitRateLimit(key, minIntervalMs) {
  const now = Date.now();
  const cur = RL.get(key) || { lastMs: 0 };
  if (now - cur.lastMs < minIntervalMs) return true;
  RL.set(key, { lastMs: now });
  return false;
}

// HTML escape (Telegram parse_mode HTML)
function escHtml(s) {
  return safeText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// =========================================================
// Inline Keyboard
// =========================================================
function buildPriorityKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "🟢 Baixa", callback_data: `pr:${taskId}:baixa` },
        { text: "🟡 Média", callback_data: `pr:${taskId}:media` },
      ],
      [
        { text: "🟠 Alta", callback_data: `pr:${taskId}:alta` },
        { text: "🔴 Urgente", callback_data: `pr:${taskId}:urgente` },
      ],
    ],
  };
}

function parsePriorityCallback(data) {
  const t = safeText(data);
  const m = t.match(/^pr:([^:]+):(baixa|media|alta|urgente)$/i);
  if (!m) return null;
  return { taskId: m[1], priority: normalizePriority(m[2]) };
}

// ✅ Novos botões de decisão do Master
function parseDecisionCallback(data) {
  const t = safeText(data);
  const m = t.match(/^decide:(close|reopen|ask|view):(.+)$/i);
  if (!m) return null;
  return { action: String(m[1]).toLowerCase(), taskId: String(m[2]).trim() };
}

// =========================================================
// Firestore helpers
// =========================================================
async function isChatLinked(usersCol, chatId) {
  if (!usersCol || !chatId) return false;
  const snap = await usersCol.where("telegramChatId", "==", chatId).limit(1).get();
  return !snap.empty;
}

async function markUpdateOnce(telegramUpdatesCol, updateId) {
  if (!telegramUpdatesCol || !updateId) return { duplicated: false };
  const ref = telegramUpdatesCol.doc(String(updateId));
  const snap = await ref.get();
  if (snap.exists) return { duplicated: true };
  await ref.set({ updateId: String(updateId), receivedAt: nowTS() }, { merge: true });
  return { duplicated: false };
}

async function setUpdateStatus(telegramUpdatesCol, updateId, patch) {
  if (!telegramUpdatesCol || !updateId) return;
  await telegramUpdatesCol.doc(String(updateId)).set({ ...patch, updatedAt: nowTS() }, { merge: true });
}

async function updateTaskPriority(tasksCol, taskId, newPriority) {
  if (!tasksCol || !taskId) return { ok: false, reason: "missing_args" };

  const ref = tasksCol.doc(String(taskId));
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "not_found" };

  await ref.set({ priority: newPriority, updatedAt: nowTS() }, { merge: true });
  return { ok: true, taskId: String(taskId) };
}

async function getTask(tasksCol, taskId) {
  if (!tasksCol || !taskId) return { ok: false, reason: "missing_args" };
  const ref = tasksCol.doc(String(taskId));
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  return { ok: true, ref, task: { id: snap.id, ...snap.data() } };
}

function taskTitle(task) {
  return (
    safeText(task?.title) ||
    safeText(task?.telegram?.title) ||
    safeText(task?.description) ||
    safeText(task?.message) ||
    "(sem título)"
  );
}

function decisionResultText(action, title) {
  if (action === "close") return `✅ <b>Decisão do Master:</b>\nA tarefa <b>${escHtml(title)}</b> foi <b>FECHADA</b>.`;
  if (action === "reopen") return `↩️ <b>Decisão do Master:</b>\nA tarefa <b>${escHtml(title)}</b> foi <b>REABERTA</b>.`;
  if (action === "ask") return `❓ <b>Decisão do Master:</b>\nSolicitados <b>mais detalhes</b> sobre <b>${escHtml(title)}</b>.`;
  return `✅ OK`;
}

function fmtTaskDetailsHTML(task) {
  const id = escHtml(task?.id);
  const title = escHtml(taskTitle(task));
  const status = escHtml(task?.status || "—");
  const prio = escHtml(task?.priority || task?.telegram?.priority || "—");
  const src = escHtml(task?.source || "—");
  const from = escHtml(task?.createdBy?.name || task?.by?.name || "—");

  const officeState =
    task?.officeSignal && typeof task.officeSignal === "object"
      ? escHtml(task.officeSignal.state || "—")
      : escHtml(task?.officeSignal || "—");

  const officeComment =
    task?.officeSignal && typeof task.officeSignal === "object"
      ? escHtml(task.officeSignal.comment || "")
      : escHtml(task?.officeComment || "");

  const lines = [];
  lines.push(`<b>🧾 Detalhes da tarefa</b>`);
  lines.push(`<b>Título:</b> ${title}`);
  lines.push(`<b>Status:</b> ${status}`);
  lines.push(`<b>Prioridade:</b> ${prio}`);
  lines.push(`<b>De:</b> ${from}`);
  lines.push(`<b>Fonte:</b> ${src}`);
  lines.push(`<b>Office signal:</b> ${officeState}`);
  if (officeComment) lines.push(`<b>Comentário office:</b> ${officeComment}`);
  lines.push(``);
  lines.push(`<b>ID:</b> <code>${id}</code>`);
  return lines.join("\n");
}

// =========================================================
// Handler
// =========================================================
async function handleUpdate(tg, cfg, req, res) {
  const t0 = Date.now();

  try {
    const update = req.body || {};
    const updateId = update?.update_id != null ? String(update.update_id) : null;

    // Secret do webhook (se usar)
    if (cfg.TELEGRAM_WEBHOOK_SECRET) {
      const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
      if (secretHeader && String(secretHeader) !== String(cfg.TELEGRAM_WEBHOOK_SECRET)) {
        return res.status(401).json({ ok: false });
      }
    }

    const { usersCol, tasksCol, linkTokensCol, telegramUpdatesCol } = collections();

    // idempotência
    if (updateId) {
      const once = await markUpdateOnce(telegramUpdatesCol, updateId);
      if (once.duplicated) return res.json({ ok: true, duplicated: true });
    }

    const lockOn = isAuthLockOn(cfg);
    const masterChatId = String(cfg.MASTER_CHAT_ID || "").trim();
    const officeChatId = String(cfg.OFFICE_CHAT_ID || "").trim();

    // =====================================================
    // 1) CALLBACK QUERY (botões)
    // =====================================================
    if (update.callback_query) {
      const cq = update.callback_query;
      const cqId = cq.id;
      const data = cq.data;
      const msg = cq.message || {};
      const chatId = msg?.chat?.id;
      const messageId = msg?.message_id;

      // 🔹 Primeiro: trata DECISÃO do master
      const decide = parseDecisionCallback(data);
      if (decide) {
        // Só o masterChatId pode decidir (mais seguro/objetivo)
        if (!masterChatId || String(chatId) !== String(masterChatId)) {
          await tgAnswerCallback(tg, cqId, "Somente o Master pode decidir.", true);
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "callback_decide_not_master" });
          return res.json({ ok: true });
        }

        // (Opcional) se AUTH_LOCK estiver ON, ainda assim masterChatId passa (e não depende de /link)
        // Se quiser obrigar link do master, eu ajusto depois.

        const got = await getTask(tasksCol, decide.taskId);
        if (!got.ok) {
          await tgAnswerCallback(tg, cqId, "Não encontrei a tarefa.", true);
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "callback_decide_task_not_found" });
          return res.json({ ok: true });
        }

        const { ref, task } = got;
        const title = taskTitle(task);

        const from = cq?.from || {};
        const by = {
          uid: from?.id ? `tg:${from.id}` : "tg:unknown",
          name: from?.username ? `@${from.username}` : safeText(from?.first_name || "master"),
          email: null,
          source: "telegram",
          telegramUserId: from?.id || null,
          telegramChatId: chatId || null,
        };

        // Ação: view (somente manda detalhes e mantém botões)
        if (decide.action === "view") {
          await tgAnswerCallback(tg, cqId, "Enviando detalhes…", false);

          await tgSend(tg, chatId, fmtTaskDetailsHTML(task), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }).catch(() => {});

          // Mantém a mensagem original como está (não remove botões)
          if (updateId) {
            await setUpdateStatus(telegramUpdatesCol, updateId, {
              status: "callback_decide_view",
              taskId: decide.taskId,
              ms: Date.now() - t0,
            });
          }

          return res.json({ ok: true });
        }

        // Atualizações de decisão
        const patch = {
          updatedAt: nowTS(),
          updatedBy: by,
          audit: (task.audit || []).concat([
            {
              action: "master_decision",
              at: nowTS(),
              by: { userId: by.uid, name: by.name },
              meta: { decision: decide.action },
            },
          ]),
        };

        if (decide.action === "close") {
          patch.status = "feito"; // ✅ ajuste se quiser "feito_detalhes" etc
          patch.masterDecidedAt = nowTS();
          patch.masterDecision = { action: "close", by, at: nowTS() };
        } else if (decide.action === "reopen") {
          patch.status = "aberta";
          patch.masterDecidedAt = nowTS();
          patch.masterDecision = { action: "reopen", by, at: nowTS() };
        } else if (decide.action === "ask") {
          patch.masterAskedDetailsAt = nowTS();
          patch.masterAskedDetailsBy = by;
          patch.masterDecision = { action: "ask", by, at: nowTS() };
        } else {
          await tgAnswerCallback(tg, cqId, "Ação não suportada.", true);
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "callback_decide_unknown" });
          return res.json({ ok: true });
        }

        await ref.set(patch, { merge: true });

        await tgAnswerCallback(tg, cqId, "OK ✅", false);

        // Edita a mensagem original, removendo botões (para close/reopen/ask)
        if (chatId && messageId) {
          const edited = decisionResultText(decide.action, title);
          await tgEdit(tg, chatId, messageId, edited, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [] }, // remove teclado
          }).catch(() => {});
        }

        if (updateId) {
          await setUpdateStatus(telegramUpdatesCol, updateId, {
            status: `callback_decide_${decide.action}`,
            taskId: decide.taskId,
            ms: Date.now() - t0,
          });
        }

        return res.json({ ok: true });
      }

      // 🔹 Depois: trata PRIORIDADE (fluxo atual)
      const parsed = parsePriorityCallback(data);
      if (!parsed) {
        await tgAnswerCallback(tg, cqId, "Comando inválido.", false);
        if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "callback_invalid" });
        return res.json({ ok: true });
      }

      if (lockOn) {
        const linked = await isChatLinked(usersCol, chatId);
        if (!linked) {
          await tgAnswerCallback(tg, cqId, "Acesso restrito. Faça /link no painel.", true);
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "callback_locked_not_linked" });
          return res.json({ ok: true });
        }
      }

      const pr = normalizePriority(parsed.priority);
      const badge = priorityBadge(pr);

      const upd = await updateTaskPriority(tasksCol, parsed.taskId, pr);
      if (!upd.ok) {
        await tgAnswerCallback(tg, cqId, "Não encontrei a tarefa para atualizar.", true);
        if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "callback_task_not_found" });
        return res.json({ ok: true });
      }

      await tgAnswerCallback(tg, cqId, `Prioridade: ${badge}`, false);

      if (chatId && messageId) {
        const editedText =
          `✅ Recebido! Já enviei para o escritório.\n\n` +
          `📌 Prioridade: ${badge}\n` +
          `🧾 Protocolo: ${parsed.taskId}\n\n` +
          `Toque para alterar:`;

        await tgEdit(tg, chatId, messageId, editedText, {
          reply_markup: buildPriorityKeyboard(parsed.taskId),
        }).catch(() => {});
      }

      if (updateId) {
        await setUpdateStatus(telegramUpdatesCol, updateId, {
          status: "callback_priority_updated",
          taskId: parsed.taskId,
          priority: pr,
          ms: Date.now() - t0,
        });
      }

      return res.json({ ok: true });
    }

    // =====================================================
    // 2) MESSAGE (texto normal)
    // =====================================================
    const msg = update.message || update.edited_message || null;
    if (!msg) return res.json({ ok: true });

    const chatId = msg?.chat?.id;
    const fromId = msg?.from?.id;
    const rawText = safeText(msg?.text);
    if (!chatId) return res.json({ ok: true });

    if (rawText === "/start" || rawText === "/help") {
      await tgSend(
        tg,
        chatId,
        "✅ VeroBot\n\nEnvie sua solicitação.\n\nDepois escolha a prioridade nos botões.\n\n(Alternativa: /p baixa|media|alta|urgente)"
      );
      if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "help" });
      return res.json({ ok: true });
    }

    if (fromId && hitRateLimit(`u:${fromId}`, 2500)) {
      await tgSend(tg, chatId, "⏳ Aguarde 2s e tente novamente.");
      if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "rate_limited" });
      return res.json({ ok: true });
    }

    // LOCK ON
    if (lockOn) {
      const isLinked = await isChatLinked(usersCol, chatId);

      const linkMatch = rawText.match(/^\/link(?:@[\w_]+)?\s+(\S+)\s*$/i);
      if (!isLinked && linkMatch && linkMatch[1]) {
        const tokenId = String(linkMatch[1]).trim();
        if (!linkTokensCol) {
          await tgSend(tg, chatId, "❌ Vinculação indisponível.");
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "link_unavailable" });
          return res.json({ ok: true });
        }

        const tokenRef = linkTokensCol.doc(tokenId);
        const tokenSnap = await tokenRef.get();
        if (!tokenSnap.exists) {
          await tgSend(tg, chatId, "❌ Token inválido. Gere outro no painel.");
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "link_invalid_token" });
          return res.json({ ok: true });
        }

        const tokenDoc = tokenSnap.data() || {};
        if (tokenDoc.consumedAt) {
          await tgSend(tg, chatId, "⚠️ Token já usado. Gere outro no painel.");
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "link_consumed" });
          return res.json({ ok: true });
        }

        const uid = String(tokenDoc.uid || "").trim();
        if (!uid) {
          await tgSend(tg, chatId, "❌ Token inválido (sem UID).");
          if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "link_missing_uid" });
          return res.json({ ok: true });
        }

        await usersCol.doc(uid).set(
          {
            telegramUserId: fromId || null,
            telegramChatId: chatId,
            telegramLinkedAt: nowTS(),
            updatedAt: nowTS(),
          },
          { merge: true }
        );

        await tokenRef.set(
          { consumedAt: nowTS(), consumedByChatId: chatId, consumedByUserId: fromId || null },
          { merge: true }
        );

        await tgSend(tg, chatId, "✅ Telegram vinculado!");
        if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "linked_ok" });
        return res.json({ ok: true });
      }

      if (!isLinked) {
        await tgSend(tg, chatId, "🔒 Acesso restrito.\n\nVincule no painel:\n/link SEU_TOKEN");
        if (updateId) await setUpdateStatus(telegramUpdatesCol, updateId, { status: "locked_not_linked" });
        return res.json({ ok: true });
      }
    }

    const parsedCmd = parsePriorityFromCommand(rawText);
    const pr = normalizePriority(parsedCmd.priority || detectPriorityFromText(parsedCmd.cleanText));
    const finalText = safeText(parsedCmd.cleanText) || safeText(rawText) || "(sem texto)";
    const title = buildTitle(finalText);

    const userLabel = fmtUserLabel(msg);

    const by = {
      uid: `tg:${fromId || "unknown"}`,
      name: userLabel,
      email: null,
      source: "telegram",
      telegramUserId: fromId || null,
      telegramChatId: chatId,
    };

    let createdId = null;

    if (tasksCol) {
      const docRef = await tasksCol.add({
        message: finalText,
        text: finalText,
        content: finalText,
        body: finalText,
        description: finalText,
        title,

        by,
        createdBy: by,

        status: "aberta",
        priority: pr,

        officeSignal: null,
        officeComment: "",
        officeSignaledAt: null,

        createdAt: nowTS(),
        updatedAt: nowTS(),

        source: lockOn ? "telegram_locked" : "telegram_public",
        telegram: {
          updateId: updateId || null,
          rawText,
          cleanText: finalText,
          priority: pr,
          fromId: fromId || null,
          chatId,
          userLabel,
        },
      });

      createdId = docRef?.id || null;
    }

    const badge = priorityBadge(pr);
    const payloadHtml =
      `📩 <b>${badge}</b>\n` +
      `<b>Tarefa:</b> ${escHtml(title)}\n` +
      `<b>De:</b> ${escHtml(userLabel)}\n\n` +
      `<b>Mensagem:</b>\n${escHtml(finalText)}\n` +
      (createdId ? `\n<b>ID:</b> <code>${escHtml(createdId)}</code>\n` : "");

    if (masterChatId) await tgSend(tg, masterChatId, payloadHtml, { parse_mode: "HTML" });
    if (officeChatId) await tgSend(tg, officeChatId, payloadHtml, { parse_mode: "HTML" });

    const reply =
      `✅ Recebido! Já enviei para o escritório.\n\n` +
      `📌 Prioridade: ${badge}\n` +
      (createdId ? `🧾 Protocolo: ${createdId}\n\n` : "\n") +
      `Toque para alterar:`;

    // ✅ Só envia botões se tem protocolo
    if (createdId) {
      await tgSend(tg, chatId, reply, {
        reply_markup: buildPriorityKeyboard(createdId),
      });
    } else {
      await tgSend(
        tg,
        chatId,
        reply + "\n⚠️ Não consegui gerar o protocolo agora. Tente novamente em instantes."
      );
    }

    if (updateId) {
      await setUpdateStatus(telegramUpdatesCol, updateId, {
        status: "task_created_with_buttons",
        taskId: createdId,
        priority: pr,
        lockOn: !!lockOn,
        ms: Date.now() - t0,
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram][webhookHandler] error:", err);
    return res.status(200).json({ ok: true });
  }
}

module.exports = { handleUpdate };