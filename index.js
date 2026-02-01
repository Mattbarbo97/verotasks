require("dotenv").config();
const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

/**
 * ENV obrigatórias:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_WEBHOOK_SECRET   (string inventada)
 * - BASE_URL                  (https://seuapp.onrender.com)
 * - FIREBASE_SERVICE_ACCOUNT  (JSON do service account)
 *
 * ENV opcionais/novas:
 * - OFFICE_CHAT_ID            (-100... do grupo do escritório)
 * - MASTER_CHAT_ID            (chat_id do master no privado)
 * - OFFICE_API_SECRET         (senha longa para o Web chamar /office/*)
 * - CORS_ORIGINS              (csv: http://localhost:5173,https://verotasks.netlify.app)
 * - PORT                      (Render injeta)
 */

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  BASE_URL,
  OFFICE_CHAT_ID,
  FIREBASE_SERVICE_ACCOUNT,
  PORT,

  MASTER_CHAT_ID,
  OFFICE_API_SECRET,
  CORS_ORIGINS,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_WEBHOOK_SECRET) throw new Error("Missing TELEGRAM_WEBHOOK_SECRET");
if (!BASE_URL) throw new Error("Missing BASE_URL");
if (!FIREBASE_SERVICE_ACCOUNT) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

if (!MASTER_CHAT_ID) throw new Error("Missing MASTER_CHAT_ID");
if (!OFFICE_API_SECRET) throw new Error("Missing OFFICE_API_SECRET");

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const tasksCol = db.collection("tasks");
const awaitingCol = db.collection("awaiting_details"); // docId=userId (fluxo "feito c/ detalhes" do escritório)
const awaitingMasterCol = db.collection("awaiting_master_comment"); // docId=userId (master vai responder)

const tg = axios.create({
  baseURL: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`,
  timeout: 20000,
});

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================
   CORS (para Netlify + dev)
   ========================= */
const allowedOrigins = String(CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Office-Secret");
  }

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

function nowTS() {
  return admin.firestore.Timestamp.now();
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function userLabel(from = {}) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || from.username || String(from.id || "usuario");
}

function inferPriority(text = "") {
  const t = text.toLowerCase();
  const high = [
    "urgente",
    "agora",
    "hoje",
    "parou",
    "quebrou",
    "cliente",
    "erro",
    "nao funciona",
    "não funciona",
  ];
  const low = ["quando der", "depois", "amanha", "amanhã", "sem pressa"];
  if (high.some((k) => t.includes(k))) return "alta";
  if (low.some((k) => t.includes(k))) return "baixa";
  return "media";
}

function badgePriority(p) {
  if (p === "alta") return "🔴 <b>ALTA</b>";
  if (p === "baixa") return "🟢 <b>BAIXA</b>";
  return "🟡 <b>MÉDIA</b>";
}

function badgeStatus(s) {
  const map = {
    aberta: "🆕 <b>ABERTA</b>",
    pendente: "⏳ <b>PENDENTE</b>",
    feito: "✅ <b>FEITO</b>",
    feito_detalhes: "📝 <b>FEITO (COM DETALHES)</b>",
    deu_ruim: "🚫 <b>DEU RUIM</b>",
  };
  return map[s] || `<b>${escapeHtml(s)}</b>`;
}

function badgeOfficeSignal(sig) {
  const map = {
    em_andamento: "🛠️ <b>EM ANDAMENTO</b>",
    ajuda: "🆘 <b>PRECISO DE AJUDA</b>",
    deu_ruim: "🚨 <b>DEU RUIM</b>",
    comentario: "💬 <b>COMENTÁRIO</b>",
  };
  return map[sig] || (sig ? `<b>${escapeHtml(sig)}</b>` : "—");
}

function taskCardText(taskId, t) {
  const createdAt = t.createdAt?.toDate ? t.createdAt.toDate() : new Date();
  const createdAtStr = createdAt.toLocaleString("pt-BR");
  const msg = t.source?.text || "—";

  let detailsBlock = "";
  if (t.status === "feito_detalhes" && t.details) {
    detailsBlock = `\n\n<b>Detalhes:</b>\n${escapeHtml(t.details)}`;
  }

  // bloco do escritório (sinal / comentário)
  let officeBlock = "";
  if (t.officeSignal) {
    const when = t.officeSignaledAt?.toDate ? t.officeSignaledAt.toDate().toLocaleString("pt-BR") : "—";
    officeBlock =
      `\n\n<b>Sinal do escritório:</b> ${badgeOfficeSignal(t.officeSignal)}\n` +
      `<b>Em:</b> ${escapeHtml(when)}` +
      (t.officeComment ? `\n<b>Comentário:</b>\n${escapeHtml(t.officeComment)}` : "");
  }

  // último comentário do master (se existir)
  let masterBlock = "";
  if (t.masterComment) {
    const when = t.masterCommentAt?.toDate ? t.masterCommentAt.toDate().toLocaleString("pt-BR") : "—";
    masterBlock =
      `\n\n<b>Resposta do master:</b>\n${escapeHtml(t.masterComment)}\n<b>Em:</b> ${escapeHtml(when)}`;
  }

  return (
    `🧾 <b>Tarefa</b> #<code>${taskId}</code>\n` +
    `👤 <b>De:</b> ${escapeHtml(t.createdBy?.name || "—")}\n` +
    `🕒 <b>Em:</b> ${escapeHtml(createdAtStr)}\n` +
    `⚡ <b>Prioridade:</b> ${badgePriority(t.priority)}\n` +
    `📌 <b>Status:</b> ${badgeStatus(t.status)}\n\n` +
    `<b>Mensagem:</b>\n${escapeHtml(msg)}` +
    detailsBlock +
    officeBlock +
    masterBlock
  );
}

/* =========================
   Keyboards
   ========================= */

function mainKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "🔴 Alta", callback_data: `prio:${taskId}:alta` },
        { text: "🟡 Média", callback_data: `prio:${taskId}:media` },
        { text: "🟢 Baixa", callback_data: `prio:${taskId}:baixa` },
      ],
      [{ text: "✅ Concluir", callback_data: `close:${taskId}` }],
    ],
  };
}

function closeKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Feito", callback_data: `status:${taskId}:feito` },
        { text: "📝 Feito c/ detalhes", callback_data: `status:${taskId}:feito_detalhes` },
      ],
      [
        { text: "⏳ Pendente", callback_data: `status:${taskId}:pendente` },
        { text: "🚫 Deu ruim", callback_data: `status:${taskId}:deu_ruim` },
      ],
      [{ text: "↩️ Voltar", callback_data: `back:${taskId}` }],
    ],
  };
}

function masterKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Concluir", callback_data: `mstatus:${taskId}:feito` },
        { text: "⏳ Pendente", callback_data: `mstatus:${taskId}:pendente` },
      ],
      [{ text: "🚫 Deu ruim", callback_data: `mstatus:${taskId}:deu_ruim` }],
      [{ text: "💬 Responder", callback_data: `mcomment:${taskId}` }],
    ],
  };
}

/* =========================
   Telegram helpers
   ========================= */

async function tgSendMessage(chatId, text, opts = {}) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML", ...opts };
  const { data } = await tg.post("/sendMessage", payload);
  if (!data.ok) throw new Error(`sendMessage failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function tgEditMessage(chatId, messageId, text, opts = {}) {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...opts };
  const { data } = await tg.post("/editMessageText", payload);
  if (!data.ok) throw new Error(`editMessageText failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function tgAnswerCallback(callbackQueryId, text = "Ok ✅") {
  const payload = { callback_query_id: callbackQueryId, text, show_alert: false };
  const { data } = await tg.post("/answerCallbackQuery", payload);
  if (!data.ok) throw new Error(`answerCallbackQuery failed: ${JSON.stringify(data)}`);
}

function verifyWebhookSecret(req) {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  return secret === TELEGRAM_WEBHOOK_SECRET;
}

/* =========================
   Awaiting helpers
   ========================= */

async function setAwaiting(userId, taskId) {
  await awaitingCol.doc(String(userId)).set({ taskId, at: nowTS() });
}

async function popAwaiting(userId) {
  const ref = awaitingCol.doc(String(userId));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  await ref.delete();
  return data;
}

async function setAwaitingMaster(userId, taskId) {
  await awaitingMasterCol.doc(String(userId)).set({ taskId, at: nowTS() });
}

async function popAwaitingMaster(userId) {
  const ref = awaitingMasterCol.doc(String(userId));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  await ref.delete();
  return data;
}

/* =========================
   Commands
   ========================= */

async function handleCommand(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = (message.text || "").trim();

  if (text === "/start") {
    await tgSendMessage(
      chatId,
      "✅ VeroTasks Bot online.\n\nEnvie uma tarefa em texto e eu vou registrar e mandar pro escritório com botões."
    );
    return true;
  }

  if (text === "/id") {
    const info =
      `🧾 <b>Chat Info</b>\n` +
      `• chat_id: <code>${chatId}</code>\n` +
      `• type: <code>${escapeHtml(message.chat.type || "—")}</code>\n` +
      (message.chat.title ? `• title: <b>${escapeHtml(message.chat.title)}</b>\n` : "") +
      (from?.id ? `• user_id: <code>${from.id}</code>\n` : "");
    await tgSendMessage(chatId, info);
    return true;
  }

  return false;
}

/* =========================
   Office API security
   ========================= */

function requireOfficeAuth(req, res, next) {
  const secret = req.headers["x-office-secret"];
  if (!secret || String(secret) !== String(OFFICE_API_SECRET)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

/* =========================
   Helpers: refresh office card
   ========================= */

async function refreshOfficeCard(taskId) {
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data();
  if (!t.office?.chatId || !t.office?.messageId) return;

  const closing = t.status === "feito" || t.status === "feito_detalhes" || t.status === "deu_ruim";
  const kb = closing ? { inline_keyboard: [] } : mainKeyboard(taskId);

  await tgEditMessage(t.office.chatId, t.office.messageId, taskCardText(taskId, t), { reply_markup: kb });
}

/* =========================
   Main handlers
   ========================= */

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || "";

  if (!text) return;

  // comandos
  if (text.startsWith("/")) {
    const handled = await handleCommand(message);
    if (handled) return;
  }

  // 1) master está aguardando uma resposta/comentário?
  const awaitingMaster = await popAwaitingMaster(from.id);
  if (awaitingMaster?.taskId) {
    await saveMasterComment(awaitingMaster.taskId, from, text);
    await tgSendMessage(chatId, "✅ Resposta enviada ao escritório e registrada na tarefa.");
    return;
  }

  // 2) detalhes pendentes (feito_detalhes) do escritório?
  const awaiting = await popAwaiting(from.id);
  if (awaiting?.taskId) {
    await finalizeWithDetails(awaiting.taskId, from, text);
    await tgSendMessage(chatId, "✅ Detalhes salvos e tarefa finalizada.");
    return;
  }

  // criar task no Firestore
  const priority = inferPriority(text);
  const createdByName = userLabel(from);

  const ref = await tasksCol.add({
    createdAt: nowTS(),
    createdBy: { chatId, userId: from.id, name: createdByName },
    source: { chatId, messageId: message.message_id, text },
    office: { chatId: OFFICE_CHAT_ID ? Number(OFFICE_CHAT_ID) : chatId, messageId: null },
    priority,
    status: "aberta",
    details: "",
    closedAt: null,
    closedBy: null,

    // sinais/respostas
    officeSignal: "",
    officeComment: "",
    officeSignaledAt: null,
    masterComment: "",
    masterCommentAt: null,

    audit: [
      { at: nowTS(), by: { userId: from.id, name: createdByName }, action: "create", meta: { priority } },
    ],
  });

  const taskId = ref.id;

  await tgSendMessage(chatId, `✅ Tarefa registrada. ID: <code>${taskId}</code>`);

  // postar no escritório (ou no mesmo chat se OFFICE_CHAT_ID não estiver definido)
  const taskSnap = await ref.get();
  const t = taskSnap.data();

  const officeMsg = await tgSendMessage(t.office.chatId, taskCardText(taskId, t), {
    reply_markup: mainKeyboard(taskId),
  });

  await ref.update({
    "office.messageId": officeMsg.message_id,
    audit: admin.firestore.FieldValue.arrayUnion({
      at: nowTS(),
      by: { userId: 0, name: "bot" },
      action: "office_post",
      meta: { officeMessageId: officeMsg.message_id },
    }),
  });
}

async function handleCallback(cb) {
  await tgAnswerCallback(cb.id);

  const data = cb.data || "";
  const parts = data.split(":");
  const action = parts[0];
  const taskId = parts[1];
  const value = parts[2];

  if (!taskId) return;

  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data();
  const operatorName = userLabel(cb.from);
  const officeChatId = t.office?.chatId;
  const officeMessageId = t.office?.messageId;

  // =====================
  // MASTER callbacks
  // =====================
  if (action === "mstatus") {
    // só master
    if (String(cb.from?.id || "") !== String(MASTER_CHAT_ID)) return;

    if (!["pendente", "feito", "deu_ruim"].includes(value)) return;

    const closing = value === "feito" || value === "deu_ruim";

    await ref.update({
      status: value,
      closedAt: closing ? nowTS() : null,
      closedBy: { userId: cb.from.id, name: operatorName, via: "master" },
      // limpa sinal do escritório após decisão
      officeSignal: "",
      officeComment: "",
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "master_status",
        meta: { status: value },
      }),
    });

    // atualiza card do escritório
    await refreshOfficeCard(taskId);

    // notifica solicitante (quem criou)
    const updated = (await ref.get()).data();
    const createdChatId = updated.createdBy?.chatId;
    if (createdChatId) {
      await tgSendMessage(
        createdChatId,
        `📣 Sua tarefa <code>${taskId}</code> foi atualizada pelo Master:\n` +
          `📌 Status: ${badgeStatus(updated.status)}\n` +
          `⚡ Prioridade: ${badgePriority(updated.priority)}`
      );
    }

    // feedback pro escritório (mensagem simples)
    if (officeChatId) {
      await tgSendMessage(
        officeChatId,
        `📬 <b>Master decidiu</b>\n` +
          `🧾 Tarefa <code>${taskId}</code>\n` +
          `📌 Status: ${badgeStatus(value)}`
      );
    }

    return;
  }

  if (action === "mcomment") {
    // só master
    if (String(cb.from?.id || "") !== String(MASTER_CHAT_ID)) return;

    await setAwaitingMaster(cb.from.id, taskId);

    await tgSendMessage(
      cb.message?.chat?.id || MASTER_CHAT_ID,
      `💬 <b>Responder tarefa</b>\n` +
        `Tarefa: <code>${taskId}</code>\n` +
        `Envie UMA mensagem com sua resposta. Vou mandar ao escritório e salvar na tarefa.`
    );
    return;
  }

  // =====================
  // OFFICE callbacks (do card do grupo do escritório)
  // =====================

  // segurança: só deixa mexer no card do escritório
  if (cb.message?.chat?.id && String(cb.message.chat.id) !== String(officeChatId)) return;

  if (action === "prio") {
    if (!["alta", "media", "baixa"].includes(value)) return;

    await ref.update({
      priority: value,
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "priority",
        meta: { priority: value },
      }),
    });

    const updated = (await ref.get()).data();
    await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
      reply_markup: mainKeyboard(taskId),
    });
    return;
  }

  if (action === "close") {
    const updated = (await ref.get()).data();
    await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
      reply_markup: closeKeyboard(taskId),
    });
    return;
  }

  if (action === "back") {
    const updated = (await ref.get()).data();
    await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
      reply_markup: mainKeyboard(taskId),
    });
    return;
  }

  if (action === "status") {
    if (!["pendente", "feito", "feito_detalhes", "deu_ruim"].includes(value)) return;

    // feito c/ detalhes: pede resposta do operador
    if (value === "feito_detalhes") {
      await ref.update({
        status: "feito_detalhes",
        closedAt: null,
        closedBy: { userId: cb.from.id, name: operatorName },
        audit: admin.firestore.FieldValue.arrayUnion({
          at: nowTS(),
          by: { userId: cb.from.id, name: operatorName },
          action: "status",
          meta: { status: "feito_detalhes" },
        }),
      });

      await setAwaiting(cb.from.id, taskId);

      await tgSendMessage(
        officeChatId,
        `📝 <b>Detalhes necessários</b> para a tarefa <code>${taskId}</code>.\nResponda com UMA mensagem contendo os detalhes.`
      );

      const updated = (await ref.get()).data();
      await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
        reply_markup: closeKeyboard(taskId),
      });
      return;
    }

    const closing = value === "feito" || value === "deu_ruim";

    await ref.update({
      status: value,
      closedAt: closing ? nowTS() : null,
      closedBy: { userId: cb.from.id, name: operatorName },
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "status",
        meta: { status: value },
      }),
    });

    const updated = (await ref.get()).data();

    // atualiza card do escritório
    await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
      reply_markup: closing ? { inline_keyboard: [] } : mainKeyboard(taskId),
    });

    // notifica solicitante
    const createdChatId = updated.createdBy?.chatId;
    if (createdChatId) {
      await tgSendMessage(
        createdChatId,
        `📣 Sua tarefa <code>${taskId}</code> foi atualizada:\n` +
          `📌 Status: ${badgeStatus(updated.status)}\n` +
          `⚡ Prioridade: ${badgePriority(updated.priority)}`
      );
    }
  }
}

async function finalizeWithDetails(taskId, from, detailsText) {
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const operatorName = userLabel(from);

  await ref.update({
    details: detailsText,
    status: "feito_detalhes",
    closedAt: nowTS(),
    closedBy: { userId: from.id, name: operatorName },
    audit: admin.firestore.FieldValue.arrayUnion({
      at: nowTS(),
      by: { userId: from.id, name: operatorName },
      action: "details",
      meta: { len: String(detailsText || "").length },
    }),
  });

  const updated = (await ref.get()).data();

  // atualiza card do escritório e remove botões
  if (updated.office?.chatId && updated.office?.messageId) {
    await tgEditMessage(updated.office.chatId, updated.office.messageId, taskCardText(taskId, updated), {
      reply_markup: { inline_keyboard: [] },
    });
  }

  // notifica solicitante
  const createdChatId = updated.createdBy?.chatId;
  if (createdChatId) {
    await tgSendMessage(
      createdChatId,
      `📣 Sua tarefa <code>${taskId}</code> foi concluída com detalhes.\n✅ Status: ${badgeStatus(updated.status)}`
    );
  }
}

async function saveMasterComment(taskId, from, commentText) {
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const masterName = userLabel(from);
  const t = snap.data();

  await ref.update({
    masterComment: commentText,
    masterCommentAt: nowTS(),
    audit: admin.firestore.FieldValue.arrayUnion({
      at: nowTS(),
      by: { userId: from.id, name: masterName },
      action: "master_comment",
      meta: { len: String(commentText || "").length },
    }),
  });

  // avisa o escritório
  if (t.office?.chatId) {
    await tgSendMessage(
      t.office.chatId,
      `💬 <b>Master respondeu</b>\n` +
        `🧾 Tarefa <code>${taskId}</code>\n\n` +
        `${escapeHtml(commentText)}`
    );
  }

  // atualiza card do escritório
  await refreshOfficeCard(taskId);
}

/* =========================
   Office API: sinalizar (Web -> Bot)
   ========================= */

app.post("/office/signal", requireOfficeAuth, async (req, res) => {
  try {
    const { taskId, signal, comment, byEmail } = req.body || {};

    if (!taskId || !signal) {
      return res.status(400).json({ ok: false, error: "missing taskId/signal" });
    }

    const normalizedSignal = String(signal || "").trim();
    if (!["em_andamento", "ajuda", "deu_ruim", "comentario"].includes(normalizedSignal)) {
      return res.status(400).json({ ok: false, error: "invalid signal" });
    }

    const ref = tasksCol.doc(String(taskId));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "task not found" });

    const t = snap.data();

    await ref.update({
      officeSignal: normalizedSignal,
      officeComment: comment ? String(comment).slice(0, 2000) : "",
      officeSignaledAt: nowTS(),
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: "office", name: String(byEmail || "office-web") },
        action: "office_signal",
        meta: { signal: normalizedSignal, hasComment: Boolean(comment) },
      }),
    });

    // atualiza card do escritório para refletir sinal
    await refreshOfficeCard(taskId);

    // notifica master com botões de decisão
    const masterText =
      `📣 <b>Escritório sinalizou</b>\n` +
      `🧾 Tarefa: <code>${taskId}</code>\n` +
      `🚦 Sinal: ${badgeOfficeSignal(normalizedSignal)}\n` +
      (comment ? `\n💬 <b>Comentário:</b>\n${escapeHtml(comment)}` : "") +
      `\n\nO que você quer fazer?`;

    await tgSendMessage(MASTER_CHAT_ID, masterText, { reply_markup: masterKeyboard(taskId) });

    return res.json({ ok: true });
  } catch (e) {
    console.error("office/signal error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   TV endpoint
   ========================= */

app.get("/tv/tasks", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);

    // pendentes / abertas para exibir na TV
    const snap = await tasksCol
      .where("status", "in", ["aberta", "pendente"])
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const items = [];
    snap.forEach((d) => {
      const x = d.data();
      items.push({
        id: d.id,
        createdAt: x.createdAt?.toDate ? x.createdAt.toDate().toISOString() : null,
        from: x.createdBy?.name || null,
        priority: x.priority,
        status: x.status,
        message: x.source?.text || "",
        officeSignal: x.officeSignal || "",
        officeComment: x.officeComment || "",
      });
    });

    res.json({ ok: true, items });
  } catch (e) {
    console.error("tv/tasks error:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   Health + Telegram webhook
   ========================= */

app.get("/", (_, res) => res.status(200).send("ok"));

app.post("/telegram/webhook", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).send("unauthorized");

    const update = req.body;

    if (update.callback_query) await handleCallback(update.callback_query);
    if (update.message) await handleMessage(update.message);

    res.status(200).send("ok");
  } catch (e) {
    console.error("webhook error:", e?.message || e, e?.response?.data);
    res.status(200).send("ok");
  }
});

app.post("/telegram/setWebhook", async (req, res) => {
  try {
    const url = `${BASE_URL}/telegram/webhook`;
    const { data } = await tg.post("/setWebhook", {
      url,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message, details: e?.response?.data });
  }
});

app.post("/telegram/deleteWebhook", async (req, res) => {
  try {
    const { data } = await tg.post("/deleteWebhook", {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message, details: e?.response?.data });
  }
});

/* =========================
   Listen
   ========================= */

const listenPort = Number(PORT || 8080);
app.listen(listenPort, () => {
  console.log(`Server online :${listenPort}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`OFFICE_CHAT_ID: ${OFFICE_CHAT_ID || "(nao definido - usando o mesmo chat)"}`);
  console.log(`MASTER_CHAT_ID: ${MASTER_CHAT_ID}`);
  console.log(`CORS_ORIGINS: ${allowedOrigins.join(",") || "(vazio)"}`);
});
