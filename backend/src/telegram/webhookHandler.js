// src/telegram/webhookHandler.js
const { collections } = require("../firebase/collections");
const { getAdmin } = require("../firebase/admin");

const { createUniqueLinkTokenDoc } = require("../services/linkTokens");
const { ensureTelegramLinkedOrThrow, isUserAllowed } = require("../services/telegramAuth");
const { popAwaiting, popAwaitingMaster, nowTS } = require("../services/awaiting");

const { inferPriority, taskCardText, isClosedStatus } = require("./text");
const { officeKeyboard, masterKeyboard } = require("./keyboards");
const { userLabel, escapeHtml, safeStr } = require("./helpers");

const {
  refreshOfficeCard,
  notifyMasterAboutOfficeSignal,
  finalizeWithDetails,
  saveMasterComment,
  masterSetStatus,
  officeSetPriority,
  masterAskComment,

  // ✅ NOVO
  masterAssignTask,
} = require("../services/tasks");

function FieldValue() {
  return getAdmin().firestore.FieldValue;
}

function verifyWebhookSecret(cfg, req) {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  return secret === cfg.TELEGRAM_WEBHOOK_SECRET;
}

function isMasterCallback(cfg, cb) {
  const chatId = cb?.message?.chat?.id;
  return String(chatId || "") === String(cfg.MASTER_CHAT_ID);
}

function isMasterMessage(cfg, message) {
  const chatId = message?.chat?.id;
  return String(chatId || "") === String(cfg.MASTER_CHAT_ID);
}

function createTelegramApi(tgClient) {
  async function sendMessage(chatId, text, opts = {}) {
    const payload = { chat_id: chatId, text, parse_mode: "HTML", ...opts };
    const { data } = await tgClient.post("/sendMessage", payload);
    if (!data.ok) throw new Error(`sendMessage failed: ${JSON.stringify(data)}`);
    return data.result;
  }

  async function editMessage(chatId, messageId, text, opts = {}) {
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...opts };
    const { data } = await tgClient.post("/editMessageText", payload);
    if (!data.ok) throw new Error(`editMessageText failed: ${JSON.stringify(data)}`);
    return data.result;
  }

  async function answerCallback(callbackQueryId, text = "Ok ✅") {
    const payload = { callback_query_id: callbackQueryId, text, show_alert: false };
    const { data } = await tgClient.post("/answerCallbackQuery", payload);
    if (!data.ok) throw new Error(`answerCallbackQuery failed: ${JSON.stringify(data)}`);
  }

  return { sendMessage, editMessage, answerCallback };
}

async function handleCommand(tgApi, cfg, message) {
  const { usersCol, linkTokensCol } = collections();
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = (message.text || "").trim();

  if (text === "/start") {
    await tgApi.sendMessage(
      chatId,
      "✅ <b>VeroTasks Bot online</b>\n\n" +
        "Faça login no painel e vincule seu Telegram.\n\n" +
        "Comando:\n<code>/link SEU_TOKEN</code>"
    );
    return true;
  }

  if (text === "/id") {
    const info =
      `🧾 <b>Chat Info</b>\n` +
      `• chat_id: <code>${escapeHtml(chatId)}</code>\n` +
      `• type: <code>${escapeHtml(message.chat.type || "—")}</code>\n` +
      (message.chat.title ? `• title: <b>${escapeHtml(message.chat.title)}</b>\n` : "") +
      (from?.id ? `• user_id: <code>${escapeHtml(from.id)}</code>\n` : "");
    await tgApi.sendMessage(chatId, info);
    return true;
  }

  // ✅ NOVO: comando do Master para atribuir
  // /assign TASK_ID UID
  if (text.toLowerCase().startsWith("/assign")) {
    if (!isMasterMessage(cfg, message)) {
      await tgApi.sendMessage(chatId, "🚫 Apenas o Master pode usar /assign.");
      return true;
    }

    const parts = text.split(/\s+/).filter(Boolean);
    const taskId = String(parts[1] || "").trim();
    const uid = String(parts[2] || "").trim();

    if (!taskId || !uid) {
      await tgApi.sendMessage(
        chatId,
        "ℹ️ Use:\n<code>/assign TASK_ID UID</code>\n\nEx:\n<code>/assign AbC123xYz uQ9....</code>"
      );
      return true;
    }

    await masterAssignTask(tgApi, cfg, { taskId, cbFrom: from, assigneeUid: uid });
    return true;
  }

  // vínculo: /link TOKEN (sempre permitido)
  if (text.toLowerCase().startsWith("/link")) {
    const parts = text.split(/\s+/).filter(Boolean);
    const token = String(parts[1] || "").trim().toUpperCase();

    if (!token) {
      await tgApi.sendMessage(chatId, "ℹ️ Use: <code>/link SEU_TOKEN</code>");
      return true;
    }

    const tokenRef = linkTokensCol.doc(token);
    const tokenSnap = await tokenRef.get();

    if (!tokenSnap.exists) {
      await tgApi.sendMessage(chatId, "🚫 Token inválido ou já usado. Gere um novo no painel.");
      return true;
    }

    const tk = tokenSnap.data() || {};
    const expiresAt = tk.expiresAt?.toDate ? tk.expiresAt.toDate() : null;

    if (!expiresAt || new Date() > expiresAt) {
      await tokenRef.delete().catch(() => {});
      await tgApi.sendMessage(chatId, "🚫 Token expirado. Gere um novo no painel.");
      return true;
    }

    const uid = String(tk.uid || "").trim();
    if (!uid) {
      await tokenRef.delete().catch(() => {});
      await tgApi.sendMessage(chatId, "🚫 Token inválido (sem uid). Gere outro no painel.");
      return true;
    }

    const userRef = usersCol.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      await tokenRef.delete().catch(() => {});
      await tgApi.sendMessage(chatId, "🚫 Usuário não existe mais. Gere um novo token no painel.");
      return true;
    }

    const userDoc = userSnap.data() || {};
    if (!isUserAllowed(userDoc)) {
      await tgApi.sendMessage(chatId, "🚫 Seu acesso está desativado. Fale com o administrador.");
      return true;
    }

    const telegramUserId = String(from.id || "");
    const telegramChatId = String(chatId || "");

    await userRef.set(
      {
        telegramUserId,
        telegramChatId,
        telegramLinkedAt: nowTS(),
        telegramLabel: userLabel(from),
      },
      { merge: true }
    );

    // token 1x
    await tokenRef.delete().catch(() => {});

    await tgApi.sendMessage(chatId, "✅ <b>Telegram vinculado com sucesso!</b>\nAgora você já pode usar o bot neste chat.");
    return true;
  }

  return false;
}

async function handleMessage(tgApi, cfg, message) {
  const { tasksCol } = collections();

  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || "";
  if (!text) return;

  // comandos passam sempre (inclui /link e /assign)
  if (text.startsWith("/")) {
    const handled = await handleCommand(tgApi, cfg, message);
    if (handled) return;
  }

  // 🔒 auth lock
  const authCheck = await ensureTelegramLinkedOrThrow(cfg, message);
  if (!authCheck.ok) {
    const reason = authCheck.reason || "not_linked";

    if (reason === "chat_mismatch") {
      await tgApi.sendMessage(
        chatId,
        "🔒 <b>Acesso restrito</b>\n\n" +
          "Seu Telegram está vinculado em <b>outro chat</b>.\n" +
          "Abra o chat correto ou gere um novo token no painel.\n\n" +
          "<code>/link SEU_TOKEN</code>"
      );
      return;
    }

    if (reason === "not_allowed") {
      await tgApi.sendMessage(chatId, "🚫 <b>Acesso desativado</b> (usuário inativo/sem permissão).");
      return;
    }

    await tgApi.sendMessage(
      chatId,
      "🔒 <b>Acesso restrito</b>\n\n" + "Faça login no painel e vincule seu Telegram.\n" + "<code>/link SEU_TOKEN</code>"
    );
    return;
  }

  // 1) Master respondendo comentário?
  const awaitingMaster = await popAwaitingMaster(from.id);
  if (awaitingMaster?.taskId) {
    if (String(chatId) !== String(cfg.MASTER_CHAT_ID)) {
      await tgApi.sendMessage(chatId, "🚫 Apenas o Master pode responder tarefas.");
      return;
    }
    await saveMasterComment(tgApi, awaitingMaster.taskId, from, text);
    await tgApi.sendMessage(chatId, "✅ Resposta enviada ao escritório.");
    return;
  }

  // 2) Escritório enviando detalhes (quando Master pediu)
  const awaiting = await popAwaiting(from.id);
  if (awaiting?.taskId) {
    await finalizeWithDetails(tgApi, awaiting.taskId, from, text);
    await tgApi.sendMessage(chatId, "✅ Detalhes salvos e tarefa finalizada.");
    return;
  }

  // 3) Criar nova tarefa
  const priority = inferPriority(text);
  const createdByName = userLabel(from);
  const officeTargetChatId = cfg.OFFICE_CHAT_ID ? Number(cfg.OFFICE_CHAT_ID) : chatId;

  const ref = await tasksCol.add({
    createdAt: nowTS(),
    createdBy: { chatId, userId: from.id, name: createdByName },
    source: { chatId, messageId: message.message_id, text },

    office: { chatId: officeTargetChatId, messageId: null },

    priority,
    status: "aberta",
    details: "",
    closedAt: null,
    closedBy: null,

    assignedTo: null,
    assignedAt: null,
    assignedBy: null,

    officeSignal: null,
    officeComment: "",
    officeSignaledAt: null,

    masterComment: "",
    masterCommentAt: null,

    audit: [
      {
        at: nowTS(),
        by: { userId: from.id, name: createdByName },
        action: "create",
        meta: { priority },
      },
    ],
  });

  const taskId = ref.id;

  await tgApi.sendMessage(chatId, `✅ Tarefa registrada.\nID: <code>${escapeHtml(taskId)}</code>`);

  const snap = await ref.get();
  const t = snap.data();

  // posta no chat do escritório
  const officeMsg = await tgApi.sendMessage(t.office.chatId, taskCardText(taskId, t), {
    reply_markup: require("./keyboards").officeKeyboard(taskId),
  });

  await ref.update({
    "office.messageId": officeMsg.message_id,
    audit: FieldValue().arrayUnion({
      at: nowTS(),
      by: { userId: "bot", name: "bot" },
      action: "office_post",
      meta: { officeMessageId: officeMsg.message_id },
    }),
  });
}

async function handleCallback(tgApi, cfg, cb) {
  try {
    await tgApi.answerCallback(cb.id);
  } catch {}

  const data = cb.data || "";
  const parts = data.split(":");
  const action = parts[0];
  const taskId = parts[1];
  const value = parts[2];

  if (!taskId) return;

  const { tasksCol } = collections();
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data() || {};
  const officeChatId = t.office?.chatId;

  // Office priority only
  if (action === "prio") {
    if (!["alta", "media", "baixa"].includes(value)) return;
    await officeSetPriority(tgApi, { taskId, cbFrom: cb.from, priority: value });
    return;
  }

  // Office: botão "enviar ações pro master"
  if (action === "to_master") {
    // só aceita se veio do chat do escritório, quando houver officeChatId
    if (cb.message?.chat?.id && officeChatId && String(cb.message.chat.id) !== String(officeChatId)) return;

    await tgApi.sendMessage(
      cfg.MASTER_CHAT_ID,
      `📨 <b>Ações do Master</b>\n` +
        `🧾 Tarefa: <code>${escapeHtml(taskId)}</code>\n` +
        `Solicitado pelo escritório.\n\n` +
        `Use os botões abaixo para decidir:`,
      { reply_markup: masterKeyboard(taskId) }
    );
    return;
  }

  // ✅ NOVO: botão "Atribuir" (ajuda)
  if (action === "massign_help") {
    if (!isMasterCallback(cfg, cb)) return;
    await tgApi.sendMessage(
      cfg.MASTER_CHAT_ID,
      `📍 <b>Atribuir tarefa</b>\n` +
        `🧾 Tarefa: <code>${escapeHtml(taskId)}</code>\n\n` +
        `Use o comando:\n` +
        `<code>/assign ${escapeHtml(taskId)} UID_DO_USUARIO</code>\n\n` +
        `O UID você pega no painel (usuários).`
    );
    return;
  }

  // Master
  if (action === "mstatus") {
    if (!isMasterCallback(cfg, cb)) return;
    if (!["pendente", "feito", "deu_ruim"].includes(value)) return;
    await masterSetStatus(tgApi, cfg, { taskId, cbFrom: cb.from, status: value });
    return;
  }

  if (action === "mcomment") {
    if (!isMasterCallback(cfg, cb)) return;
    await masterAskComment(tgApi, cfg, { taskId, cbFrom: cb.from });
    return;
  }

  if (action === "mdetails") {
    if (!isMasterCallback(cfg, cb)) return;

    // mantém o comportamento atual (só manda instrução no office)
    if (officeChatId) {
      await tgApi.sendMessage(
        officeChatId,
        `📝 <b>Master pediu detalhes</b>\n` +
          `Tarefa <code>${escapeHtml(taskId)}</code>\n` +
          `Responda com UMA mensagem contendo os detalhes para finalizar.`
      );
    }
    return;
  }
}

async function handleUpdate(tgClient, cfg, req, res) {
  const tgApi = createTelegramApi(tgClient);

  try {
    if (!verifyWebhookSecret(cfg, req)) {
      return res.status(401).send("unauthorized");
    }

    const update = req.body || {};

    if (update.callback_query) await handleCallback(tgApi, cfg, update.callback_query);
    if (update.message) await handleMessage(tgApi, cfg, update.message);

    return res.status(200).send("ok");
  } catch (e) {
    // sempre 200 pro Telegram não ficar repetindo
    console.error("telegram webhook error:", e?.message || e);
    return res.status(200).send("ok");
  }
}

module.exports = { handleUpdate };
