// index.js (FULL) — CORRIGIDO (PARTE 1/4)
// ✅ Auth lock (Telegram ↔ Firebase) + Office link token
// - Bloqueia uso do bot por usuários não vinculados (exceto OFFICE_CHAT_ID e MASTER_CHAT_ID)
// - OfficePanel gera token via /office/link-token (secret)
// - Usuário vincula no Telegram com: /link SEU_TOKEN
// - Salva em users/{uid}: telegramUserId, telegramChatId, telegramLinkedAt
// - Token expira em 10min e é 1x (apaga após uso)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

/**
 * ENV obrigatórias:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_WEBHOOK_SECRET
 * - BASE_URL
 * - FIREBASE_SERVICE_ACCOUNT (JSON string)
 * - MASTER_CHAT_ID
 * - OFFICE_API_SECRET
 * - ADMIN_API_SECRET
 *
 * ENV opcionais:
 * - OFFICE_CHAT_ID
 * - CORS_ORIGINS
 * - PORT
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
  ADMIN_API_SECRET,
  CORS_ORIGINS,
} = process.env;

// =========================
// Validations
// =========================
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_WEBHOOK_SECRET) throw new Error("Missing TELEGRAM_WEBHOOK_SECRET");
if (!BASE_URL) throw new Error("Missing BASE_URL");
if (!FIREBASE_SERVICE_ACCOUNT) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");
if (!MASTER_CHAT_ID) throw new Error("Missing MASTER_CHAT_ID");
if (!OFFICE_API_SECRET) throw new Error("Missing OFFICE_API_SECRET");
if (!ADMIN_API_SECRET) throw new Error("Missing ADMIN_API_SECRET");

// =========================
// Firebase Admin
// =========================
let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const tasksCol = db.collection("tasks");
const usersCol = db.collection("users");

// tokens p/ vincular Telegram
const linkTokensCol = db.collection("link_tokens");

// aguardando detalhe do "feito c/ detalhes" (operador do escritório)
const awaitingCol = db.collection("awaiting_details"); // docId=userId

// aguardando comentário do master (responder)
const awaitingMasterCol = db.collection("awaiting_master_comment"); // docId=userId

// =========================
// Telegram client
// =========================
const tg = axios.create({
  baseURL: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`,
  timeout: 20000,
});

// =========================
// Express app
// =========================
const app = express();
app.use(express.json({ limit: "2mb" }));

// =========================
// CORS (Netlify + dev)
// =========================
const allowedOrigins = String(CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,X-Office-Secret,X-Admin-Secret"
    );
  }

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// =========================
// Helpers (gerais)
// =========================
function nowTS() {
  return admin.firestore.Timestamp.now();
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
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

function verifyWebhookSecret(req) {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  return secret === TELEGRAM_WEBHOOK_SECRET;
}

function isClosedStatus(status) {
  return ["feito", "feito_detalhes", "deu_ruim"].includes(String(status || ""));
}

// =========================
// Telegram helpers (robustos)
// =========================
function truncateText(text, max = 3900) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 40) + "\n\n…(mensagem truncada)…";
}

function telegramErrorInfo(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const desc = data?.description || data?.error || "";
  const code = data?.error_code;
  return {
    status: status || null,
    error_code: code || null,
    description: desc || safeStr(e?.message || e),
    data: data || null,
  };
}

async function tgSendMessage(chatId, text, opts = {}) {
  const payload = {
    chat_id: chatId,
    text: truncateText(text),
    parse_mode: "HTML",
    ...opts,
  };
  try {
    const { data } = await tg.post("/sendMessage", payload);
    if (!data.ok) throw new Error(`sendMessage failed: ${JSON.stringify(data)}`);
    return data.result;
  } catch (e) {
    const info = telegramErrorInfo(e);
    console.error("tg sendMessage error:", info);
    throw e;
  }
}

async function tgEditMessage(chatId, messageId, text, opts = {}) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: truncateText(text),
    parse_mode: "HTML",
    ...opts,
  };
  try {
    const { data } = await tg.post("/editMessageText", payload);
    if (!data.ok) throw new Error(`editMessageText failed: ${JSON.stringify(data)}`);
    return data.result;
  } catch (e) {
    const info = telegramErrorInfo(e);
    console.error("tg editMessageText error:", info);
    throw e;
  }
}

async function tgAnswerCallback(callbackQueryId, text = "Ok ✅") {
  const payload = { callback_query_id: callbackQueryId, text, show_alert: false };
  try {
    const { data } = await tg.post("/answerCallbackQuery", payload);
    if (!data.ok) throw new Error(`answerCallbackQuery failed: ${JSON.stringify(data)}`);
  } catch (e) {
    const info = telegramErrorInfo(e);
    console.error("tg answerCallbackQuery error:", info);
    throw e;
  }
}

// =========================
// Awaiting helpers (Firestore)
// =========================
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

// =========================
// Office/Admin API security
// =========================
function requireOfficeAuth(req, res, next) {
  const secret = req.headers["x-office-secret"];
  if (!secret || String(secret) !== String(OFFICE_API_SECRET)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function requireAdminAuth(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || String(secret) !== String(ADMIN_API_SECRET)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// =========================
// ✅ AUTH LOCK (Telegram) — CORRIGIDO
// - agora valida (telegramUserId + telegramChatId)
// - e também role/status
// =========================
function isPrivilegedChat(chatId) {
  if (String(chatId || "") === String(MASTER_CHAT_ID)) return true;
  if (OFFICE_CHAT_ID && String(chatId || "") === String(OFFICE_CHAT_ID)) return true;
  return false;
}

function isUserAllowed(userDoc) {
  if (!userDoc) return false;
  const status = String(userDoc.status || "active");
  const role = String(userDoc.role || "office");
  if (status !== "active") return false;
  // Ajuste aqui se quiser permitir mais roles
  if (!["admin", "office"].includes(role)) return false;
  return true;
}

async function findUserByTelegramUserId(telegramUserId) {
  const uid = String(telegramUserId || "");
  if (!uid) return null;

  const snap = await usersCol.where("telegramUserId", "==", uid).limit(1).get();
  if (snap.empty) return null;

  const doc0 = snap.docs[0];
  return { id: doc0.id, ...doc0.data() };
}

/**
 * ✅ Agora: precisa estar vinculado E no mesmo chat vinculado
 * Retornos:
 * - { ok:true, bypass:true } (master/office)
 * - { ok:true, user }
 * - { ok:false, reason:"not_linked"|"chat_mismatch"|"not_allowed"|"missing_from" }
 */
async function ensureTelegramLinkedOrThrow(message) {
  const chatId = message?.chat?.id;
  const from = message?.from || {};
  const telegramUserId = String(from.id || "");
  const telegramChatId = String(chatId || "");

  if (!telegramUserId) return { ok: false, reason: "missing_from" };

  if (isPrivilegedChat(chatId)) return { ok: true, bypass: true };

  const user = await findUserByTelegramUserId(telegramUserId);
  if (!user) return { ok: false, reason: "not_linked" };

  if (!isUserAllowed(user)) return { ok: false, reason: "not_allowed" };

  // ✅ trava por chat: se foi vinculado em outro chat, bloqueia
  const linkedChat = String(user.telegramChatId || "");
  if (!linkedChat || linkedChat !== telegramChatId) {
    return { ok: false, reason: "chat_mismatch" };
  }

  return { ok: true, user };
}

// =========================
// ✅ Link token helpers — CORRIGIDO
// - TTL 10min (alinhado com o plano)
// - retry em caso de colisão
// =========================
function makeLinkToken(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function addMinutes(ts, minutes) {
  const ms = ts.toMillis ? ts.toMillis() : Date.now();
  return admin.firestore.Timestamp.fromMillis(ms + minutes * 60 * 1000);
}

async function createUniqueLinkTokenDoc({ uid, email, ttlMin = 10 }) {
  const now = nowTS();
  const expiresAt = addMinutes(now, ttlMin);

  // tenta até 10x pra evitar colisão
  for (let i = 0; i < 10; i++) {
    const token = makeLinkToken(6);
    const ref = linkTokensCol.doc(token);
    const exists = await ref.get();
    if (exists.exists) continue;

    await ref.set({
      token,
      uid: String(uid),
      email: String(email).toLowerCase(),
      createdAt: now,
      expiresAt,
      usedAt: null,
      usedByTelegramUserId: null,
      usedByTelegramChatId: null,
    });

    return { token, expiresAt, ttlMin };
  }

  throw new Error("could_not_generate_unique_token");
}
/* =========================
   ✅ Office API: gerar token p/ vincular Telegram
   - protegido por x-office-secret
   - payload: { uid, email }
   - valida se users/{uid} existe + status/role
   - TTL: 10 min (padrão)
   ========================= */
app.post("/office/link-token", requireOfficeAuth, async (req, res) => {
  try {
    const { uid, email } = req.body || {};
    const uidStr = String(uid || "").trim();
    const emailStr = String(email || "").trim().toLowerCase();

    if (!uidStr || !emailStr) {
      return res.status(400).json({ ok: false, error: "missing_uid_or_email" });
    }

    // ✅ valida usuário no Firestore
    const userRef = usersCol.doc(uidStr);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const user = userSnap.data() || {};
    if (!isUserAllowed(user)) {
      return res.status(403).json({ ok: false, error: "user_not_allowed" });
    }

    // se quiser forçar match de email (recomendado)
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
    console.error("office/link-token error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* =========================
   Admin API: create user
   - mantém seu fluxo, só garante normalização e campos consistentes
   ========================= */
app.post("/admin/createUser", requireAdminAuth, async (req, res) => {
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

        // vínculo telegram
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

/* =========================
   Commands (/start, /id, /link)
   ========================= */
async function handleCommand(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = (message.text || "").trim();

  if (text === "/start") {
    await tgSendMessage(
      chatId,
      "✅ VeroTasks Bot online.\n\n" +
        "Para usar, faça login no painel e vincule seu Telegram.\n" +
        "Comando: <code>/link SEU_TOKEN</code>"
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
    await tgSendMessage(chatId, info);
    return true;
  }

  // ✅ vínculo: /link TOKEN (sempre permitido)
  if (text.toLowerCase().startsWith("/link")) {
    const parts = text.split(/\s+/).filter(Boolean);
    const token = String(parts[1] || "").trim().toUpperCase();

    if (!token) {
      await tgSendMessage(chatId, "ℹ️ Use: <code>/link SEU_TOKEN</code>");
      return true;
    }

    const tokenRef = linkTokensCol.doc(token);
    const tokenSnap = await tokenRef.get();

    if (!tokenSnap.exists) {
      await tgSendMessage(chatId, "🚫 Token inválido ou já usado. Gere um novo no painel.");
      return true;
    }

    const tk = tokenSnap.data() || {};
    const expiresAt = tk.expiresAt?.toDate ? tk.expiresAt.toDate() : null;
    const now = new Date();

    if (!expiresAt || now > expiresAt) {
      await tokenRef.delete().catch(() => {});
      await tgSendMessage(chatId, "🚫 Token expirado. Gere um novo no painel.");
      return true;
    }

    const uid = String(tk.uid || "").trim();
    if (!uid) {
      await tokenRef.delete().catch(() => {});
      await tgSendMessage(chatId, "🚫 Token inválido (sem uid). Gere outro no painel.");
      return true;
    }

    // ✅ valida usuário
    const userRef = usersCol.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      await tokenRef.delete().catch(() => {});
      await tgSendMessage(chatId, "🚫 Usuário não existe mais. Gere um novo token no painel.");
      return true;
    }

    const userDoc = userSnap.data() || {};
    if (!isUserAllowed(userDoc)) {
      await tgSendMessage(chatId, "🚫 Seu acesso está desativado. Fale com o administrador.");
      return true;
    }

    // ✅ salva vínculo: userId + chatId do chat atual
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

    // ✅ marca token como usado e apaga (1x)
    await tokenRef.set(
      {
        usedAt: nowTS(),
        usedByTelegramUserId: telegramUserId,
        usedByTelegramChatId: telegramChatId,
      },
      { merge: true }
    );
    await tokenRef.delete().catch(() => {});

    await tgSendMessage(
      chatId,
      `✅ Telegram vinculado com sucesso!\n` +
        `Agora você já pode usar o bot neste chat.`
    );

    return true;
  }

  return false;
}
/* =========================
   Master validation
   ========================= */
function isMasterCallback(cb) {
  const chatId = cb?.message?.chat?.id;
  return String(chatId || "") === String(MASTER_CHAT_ID);
}

/* =========================
   Incoming message handler — CORRIGIDO
   ========================= */
async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || "";

  if (!text) return;

  // comandos sempre podem rodar (especialmente /link)
  if (text.startsWith("/")) {
    const handled = await handleCommand(message);
    if (handled) return;
  }

  // ✅ BLOQUEIO: exige vínculo fora dos chats privilegiados
  const authCheck = await ensureTelegramLinkedOrThrow(message);
  if (!authCheck.ok) {
    const reason = authCheck.reason || "not_linked";

    if (reason === "chat_mismatch") {
      await tgSendMessage(
        chatId,
        "🔒 <b>Acesso restrito</b>\n\n" +
          "Seu Telegram já está vinculado, mas <b>em outro chat</b>.\n" +
          "Abra o chat correto (onde você vinculou) ou gere um novo token no painel para vincular aqui.\n\n" +
          "Comando:\n<code>/link SEU_TOKEN</code>"
      );
      return;
    }

    if (reason === "not_allowed") {
      await tgSendMessage(
        chatId,
        "🚫 <b>Acesso desativado</b>\n\n" +
          "Seu usuário está inativo ou sem permissão.\n" +
          "Fale com o administrador para reativar."
      );
      return;
    }

    // not_linked / missing_from (fallback)
    await tgSendMessage(
      chatId,
      "🔒 <b>Acesso restrito</b>\n\n" +
        "Para usar o bot, faça login no painel e clique em <b>Vincular Telegram</b>.\n" +
        "Depois, envie aqui:\n" +
        "<code>/link SEU_TOKEN</code>"
    );
    return;
  }

  // 1️⃣ Master respondendo comentário?
  const awaitingMaster = await popAwaitingMaster(from.id);
  if (awaitingMaster?.taskId) {
    if (String(chatId) !== String(MASTER_CHAT_ID)) {
      await tgSendMessage(chatId, "🚫 Apenas o Master pode responder tarefas.");
      return;
    }

    await saveMasterComment(awaitingMaster.taskId, from, text);
    await tgSendMessage(chatId, "✅ Resposta enviada ao escritório.");
    return;
  }

  // 2️⃣ Escritório enviando detalhes?
  const awaiting = await popAwaiting(from.id);
  if (awaiting?.taskId) {
    // aqui já passou pelo auth lock, então ok
    await finalizeWithDetails(awaiting.taskId, from, text);
    await tgSendMessage(chatId, "✅ Detalhes salvos e tarefa finalizada.");
    return;
  }

  // 3️⃣ Criar nova tarefa
  const priority = inferPriority(text);
  const createdByName = userLabel(from);

  // ✅ se OFFICE_CHAT_ID existir, sempre manda pra lá.
  // senão, manda pro próprio chat de origem (ex.: usuário individual testando)
  const officeTargetChatId = OFFICE_CHAT_ID ? Number(OFFICE_CHAT_ID) : chatId;

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

  await tgSendMessage(chatId, `✅ Tarefa registrada.\nID: <code>${escapeHtml(taskId)}</code>`);

  const snap = await ref.get();
  const t = snap.data();

  // ✅ posta no chat do escritório
  const officeMsg = await tgSendMessage(t.office.chatId, taskCardText(taskId, t), {
    reply_markup: mainKeyboard(taskId),
  });

  await ref.update({
    "office.messageId": officeMsg.message_id,
    audit: admin.firestore.FieldValue.arrayUnion({
      at: nowTS(),
      by: { userId: "bot", name: "bot" },
      action: "office_post",
      meta: { officeMessageId: officeMsg.message_id },
    }),
  });
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

  const closing = isClosedStatus(t.status);
  const kb = closing ? { inline_keyboard: [] } : mainKeyboard(taskId);

  await tgEditMessage(t.office.chatId, t.office.messageId, taskCardText(taskId, t), {
    reply_markup: kb,
  });
}

/* =========================
   Text helpers (prioridade/status)
   ========================= */
function inferPriority(text = "") {
  const t = String(text || "").toLowerCase();
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

/* =========================
   Text card (task)
   ========================= */
function taskCardText(taskId, t) {
  const createdAt = t.createdAt?.toDate ? t.createdAt.toDate() : new Date();
  const createdAtStr = createdAt.toLocaleString("pt-BR");
  const msg = t.source?.text || "—";

  let detailsBlock = "";
  if (t.status === "feito_detalhes" && t.details) {
    detailsBlock = `\n\n<b>Detalhes:</b>\n${escapeHtml(t.details)}`;
  }

  let officeBlock = "";
  if (t.officeSignal && typeof t.officeSignal === "object" && t.officeSignal.state) {
    const when = t.officeSignal.updatedAt?.toDate
      ? t.officeSignal.updatedAt.toDate().toLocaleString("pt-BR")
      : "—";
    const comment = safeStr(t.officeSignal.comment || "");
    officeBlock =
      `\n\n<b>Sinal do escritório:</b> <b>${escapeHtml(String(t.officeSignal.state))}</b>\n` +
      `<b>Em:</b> ${escapeHtml(when)}` +
      (comment ? `\n<b>Comentário:</b>\n${escapeHtml(comment)}` : "");
  }

  let masterBlock = "";
  if (t.masterComment) {
    const when = t.masterCommentAt?.toDate
      ? t.masterCommentAt.toDate().toLocaleString("pt-BR")
      : "—";
    masterBlock =
      `\n\n<b>Resposta do master:</b>\n${escapeHtml(t.masterComment)}\n<b>Em:</b> ${escapeHtml(when)}`;
  }

  return (
    `🧾 <b>Tarefa</b> #<code>${escapeHtml(taskId)}</code>\n` +
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
   Keyboards (Inline)
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
      [{ text: "🚫 Apresentou problemas", callback_data: `mstatus:${taskId}:deu_ruim` }],
      [{ text: "💬 Responder", callback_data: `mcomment:${taskId}` }],
    ],
  };
}

/* =========================
   Save / finalize helpers
   ========================= */
async function finalizeWithDetails(taskId, from, detailsText) {
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const operatorName = userLabel(from);

  await ref.update({
    details: String(detailsText || "").slice(0, 4000),
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

  if (updated.office?.chatId && updated.office?.messageId) {
    await tgEditMessage(updated.office.chatId, updated.office.messageId, taskCardText(taskId, updated), {
      reply_markup: { inline_keyboard: [] },
    });
  }

  const createdChatId = updated.createdBy?.chatId;
  if (createdChatId) {
    await tgSendMessage(
      createdChatId,
      `📣 Sua tarefa <code>${escapeHtml(taskId)}</code> foi concluída com detalhes.\n✅ Status: ${badgeStatus(
        updated.status
      )}`
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
    masterComment: String(commentText || "").slice(0, 2000),
    masterCommentAt: nowTS(),
    audit: admin.firestore.FieldValue.arrayUnion({
      at: nowTS(),
      by: { userId: from.id, name: masterName },
      action: "master_comment",
      meta: { len: String(commentText || "").length },
    }),
  });

  if (t.office?.chatId) {
    await tgSendMessage(
      t.office.chatId,
      `💬 <b>Master respondeu</b>\n` +
        `🧾 Tarefa <code>${escapeHtml(taskId)}</code>\n\n` +
        `${escapeHtml(commentText)}`
    );
  }

  await refreshOfficeCard(taskId);
}

/* =========================
   Callback handler (fluxo igual, hardening leve)
   ========================= */
async function handleCallback(cb) {
  // não deixa callback travar o webhook
  try {
    await tgAnswerCallback(cb.id);
  } catch {}

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

  // MASTER callbacks
  if (action === "mstatus") {
    if (!isMasterCallback(cb)) return;
    if (!["pendente", "feito", "deu_ruim"].includes(value)) return;

    const closing = value === "feito" || value === "deu_ruim";

    await ref.update({
      status: value,
      closedAt: closing ? nowTS() : null,
      closedBy: { userId: cb.from.id, name: operatorName, via: "master" },
      officeSignal: null,
      officeComment: "",
      officeSignaledAt: null,
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "master_status",
        meta: { status: value },
      }),
    });

    await refreshOfficeCard(taskId);

    const updated = (await ref.get()).data();

    const createdChatId = updated.createdBy?.chatId;
    if (createdChatId) {
      await tgSendMessage(
        createdChatId,
        `📣 Sua tarefa <code>${escapeHtml(taskId)}</code> foi atualizada pelo Master:\n` +
          `📌 Status: ${badgeStatus(updated.status)}\n` +
          `⚡ Prioridade: ${badgePriority(updated.priority)}`
      );
    }

    if (officeChatId) {
      await tgSendMessage(
        officeChatId,
        `📬 <b>Master decidiu</b>\n` +
          `🧾 Tarefa <code>${escapeHtml(taskId)}</code>\n` +
          `📌 Status: ${badgeStatus(value)}`
      );
    }

    return;
  }

  if (action === "mcomment") {
    if (!isMasterCallback(cb)) return;

    await setAwaitingMaster(cb.from.id, taskId);
    const masterChatId = cb?.message?.chat?.id || MASTER_CHAT_ID;

    await tgSendMessage(
      masterChatId,
      `💬 <b>Responder tarefa</b>\n` +
        `🧾 Tarefa: <code>${escapeHtml(taskId)}</code>\n` +
        `Envie UMA mensagem com sua resposta.`
    );
    return;
  }

  // OFFICE callbacks: só aceita se veio do chat do escritório
  if (cb.message?.chat?.id && officeChatId && String(cb.message.chat.id) !== String(officeChatId)) return;

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
    if (officeChatId && officeMessageId) {
      await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
        reply_markup: mainKeyboard(taskId),
      });
    }
    return;
  }

  if (action === "close") {
    const updated = (await ref.get()).data();
    if (officeChatId && officeMessageId) {
      await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
        reply_markup: closeKeyboard(taskId),
      });
    }
    return;
  }

  if (action === "back") {
    const updated = (await ref.get()).data();
    if (officeChatId && officeMessageId) {
      await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
        reply_markup: mainKeyboard(taskId),
      });
    }
    return;
  }

  if (action === "status") {
    if (!["pendente", "feito", "feito_detalhes", "deu_ruim"].includes(value)) return;

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

      if (officeChatId) {
        await tgSendMessage(
          officeChatId,
          `📝 <b>Detalhes necessários</b>\n` +
            `Tarefa <code>${escapeHtml(taskId)}</code>\n` +
            `Responda com UMA mensagem contendo os detalhes.`
        );
      }

      const updated = (await ref.get()).data();
      if (officeChatId && officeMessageId) {
        await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
          reply_markup: closeKeyboard(taskId),
        });
      }
      return;
    }

    const closing = value === "feito" || value === "deu_ruim";

    await ref.update({
      status: value,
      closedAt: closing ? nowTS() : null,
      closedBy: { userId: cb.from.id, name: operatorName },
      ...(closing ? { officeSignal: null, officeComment: "", officeSignaledAt: null } : {}),
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "status",
        meta: { status: value },
      }),
    });

    const updated = (await ref.get()).data();

    if (officeChatId && officeMessageId) {
      await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
        reply_markup: closing ? { inline_keyboard: [] } : mainKeyboard(taskId),
      });
    }

    const createdChatId = updated.createdBy?.chatId;
    if (createdChatId) {
      await tgSendMessage(
        createdChatId,
        `📣 Sua tarefa <code>${escapeHtml(taskId)}</code> foi atualizada:\n` +
          `📌 Status: ${badgeStatus(updated.status)}\n` +
          `⚡ Prioridade: ${badgePriority(updated.priority)}`
      );
    }
  }
}

/* =========================
   Telegram Webhook
   ========================= */
app.post("/telegram/webhook", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) {
      return res.status(401).send("unauthorized");
    }

    const update = req.body || {};

    if (update.callback_query) await handleCallback(update.callback_query);
    if (update.message) await handleMessage(update.message);

    res.status(200).send("ok");
  } catch (e) {
    console.error("telegram webhook error:", e?.message || e);
    // importante: sempre responder 200 pro Telegram não ficar repetindo
    res.status(200).send("ok");
  }
});

/* =========================
   Health check (Render)
   ========================= */
app.get("/", (_, res) => res.status(200).send("ok"));

app.get("/health", async (_, res) => {
  try {
    await db.collection("_health").doc("ping").set({ at: nowTS() }, { merge: true });
    res.json({
      ok: true,
      service: "verotasks-backend",
      now: new Date().toISOString(),
      authLock: true,
      baseUrl: BASE_URL,
      hasOfficeChat: !!OFFICE_CHAT_ID,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   Webhook control (manual)
   ========================= */
app.post("/telegram/setWebhook", async (_, res) => {
  try {
    const url = `${BASE_URL}/telegram/webhook`;
    const { data } = await tg.post("/setWebhook", {
      url,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

app.post("/telegram/deleteWebhook", async (_, res) => {
  try {
    const { data } = await tg.post("/deleteWebhook", {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/* =========================
   Boot (Render)
   ========================= */
const listenPort = Number(PORT || 8080);

app.listen(listenPort, () => {
  console.log("✅ VeroTasks Backend online");
  console.log(`→ Port: ${listenPort}`);
  console.log(`→ BASE_URL: ${BASE_URL}`);
  console.log(`→ OFFICE_CHAT_ID: ${OFFICE_CHAT_ID || "(mesmo chat do solicitante)"}`);
  console.log(`→ MASTER_CHAT_ID: ${MASTER_CHAT_ID}`);
  console.log("→ AUTH_LOCK: ON (requires /link + chat match + role/status)");
});
