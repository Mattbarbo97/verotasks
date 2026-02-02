// index.js (FULL) — MASTER-ONLY FINALIZE (PARTE 1/4)
// ✅ Setup + helpers + auth lock + link-token + admin/createUser
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
 * - CORS_ORIGINS (csv)
 * - PORT
 * - MODE ("master_only_finalize") -> default
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
  MODE,
} = process.env;

const RUN_MODE = String(MODE || "master_only_finalize").trim();

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
} catch {
  throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const tasksCol = db.collection("tasks");
const usersCol = db.collection("users");
const linkTokensCol = db.collection("link_tokens");

// aguardando detalhe do "feito com detalhes" (operador do escritório)
const awaitingCol = db.collection("awaiting_details"); // docId=userId
// aguardando comentário do master
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

  // Se não setar CORS_ORIGINS, libera geral (útil em dev)
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Office-Secret,X-Admin-Secret");
  }

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// =========================
// Helpers
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
    console.error("tg sendMessage error:", telegramErrorInfo(e));
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
    console.error("tg editMessageText error:", telegramErrorInfo(e));
    throw e;
  }
}

async function tgAnswerCallback(callbackQueryId, text = "Ok ✅") {
  const payload = { callback_query_id: callbackQueryId, text, show_alert: false };
  try {
    const { data } = await tg.post("/answerCallbackQuery", payload);
    if (!data.ok) throw new Error(`answerCallbackQuery failed: ${JSON.stringify(data)}`);
  } catch (e) {
    console.error("tg answerCallbackQuery error:", telegramErrorInfo(e));
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
// AUTH LOCK (Telegram)
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
 * Precisa estar vinculado e no mesmo chat vinculado (fora chats privilegiados)
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

  const linkedChat = String(user.telegramChatId || "");
  if (!linkedChat || linkedChat !== telegramChatId) {
    return { ok: false, reason: "chat_mismatch" };
  }

  return { ok: true, user };
}

// =========================
// Link token helpers — TTL 10min, 1x
// =========================
function makeLinkToken(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function addMinutes(ts, minutes) {
  const ms = ts?.toMillis ? ts.toMillis() : Date.now();
  return admin.firestore.Timestamp.fromMillis(ms + minutes * 60 * 1000);
}

async function createUniqueLinkTokenDoc({ uid, email, ttlMin = 10 }) {
  const now = nowTS();
  const expiresAt = addMinutes(now, ttlMin);

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
    });

    return { token, expiresAt, ttlMin };
  }

  throw new Error("could_not_generate_unique_token");
}

// ✅ Office API: gerar token p/ vincular Telegram
app.post("/office/link-token", requireOfficeAuth, async (req, res) => {
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
    console.error("office/link-token error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ✅ Admin API: create user
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

// ⛔ Continua na PARTE 2/4
// index.js — MASTER-ONLY FINALIZE (PARTE 2/4)
const { FieldValue } = admin.firestore;

// =========================
// Text helpers (prioridade/status)
// =========================
function inferPriority(text = "") {
  const t = String(text || "").toLowerCase();
  const high = ["urgente", "agora", "hoje", "parou", "quebrou", "cliente", "erro", "nao funciona", "não funciona"];
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

function officeSignalLabel(state) {
  const s = String(state || "");
  const map = {
    em_andamento: "🛠️ <b>EM ANDAMENTO</b>",
    preciso_ajuda: "🆘 <b>PRECISO DE AJUDA</b>",
    apresentou_problemas: "🚫 <b>APRESENTOU PROBLEMAS</b>",
    tarefa_executada: "✅ <b>TAREFA EXECUTADA</b>",
    comentario: "💬 <b>COMENTÁRIO</b>",
  };
  return map[s] || `<b>${escapeHtml(s || "—")}</b>`;
}

// =========================
// Text card (task) — usado no Telegram (office chat)
// =========================
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
    const by = t.officeSignal.updatedBy?.email ? safeStr(t.officeSignal.updatedBy.email) : "";

    officeBlock =
      `\n\n<b>Escritório:</b> ${officeSignalLabel(t.officeSignal.state)}\n` +
      `<b>Em:</b> ${escapeHtml(when)}` +
      (by ? `\n<b>Por:</b> ${escapeHtml(by)}` : "") +
      (comment ? `\n<b>Comentário:</b>\n${escapeHtml(comment)}` : "");
  }

  let masterBlock = "";
  if (t.masterComment) {
    const when = t.masterCommentAt?.toDate
      ? t.masterCommentAt.toDate().toLocaleString("pt-BR")
      : "—";
    masterBlock =
      `\n\n<b>Master:</b>\n${escapeHtml(t.masterComment)}\n<b>Em:</b> ${escapeHtml(when)}`;
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

// =========================
// Keyboards
// =========================
function officeKeyboard(taskId) {
  // ✅ Escritório só muda prioridade e abre "menu master" (não finaliza nada)
  return {
    inline_keyboard: [
      [
        { text: "🔴 Alta", callback_data: `prio:${taskId}:alta` },
        { text: "🟡 Média", callback_data: `prio:${taskId}:media` },
        { text: "🟢 Baixa", callback_data: `prio:${taskId}:baixa` },
      ],
      [{ text: "📨 Enviar ações pro Master", callback_data: `to_master:${taskId}` }],
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
      [{ text: "📝 Pedir detalhes", callback_data: `mdetails:${taskId}` }],
      [{ text: "💬 Responder", callback_data: `mcomment:${taskId}` }],
    ],
  };
}

// =========================
// Refresh office card
// =========================
async function refreshOfficeCard(taskId) {
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data();
  if (!t.office?.chatId || !t.office?.messageId) return;

  const closing = isClosedStatus(t.status);
  const kb = closing ? { inline_keyboard: [] } : officeKeyboard(taskId);

  await tgEditMessage(t.office.chatId, t.office.messageId, taskCardText(taskId, t), {
    reply_markup: kb,
  });
}

// =========================
// Notify master about office signal
// =========================
async function notifyMasterAboutOfficeSignal({ taskId, t, state, comment, byEmail }) {
  const createdByName = t?.createdBy?.name ? safeStr(t.createdBy.name) : "—";
  const prio = t?.priority ? safeStr(t.priority) : "media";
  const msg = t?.source?.text ? safeStr(t.source.text) : "—";

  const text =
    `📨 <b>Escritório pediu ação</b>\n` +
    `• tarefa: <code>${escapeHtml(taskId)}</code>\n` +
    `• de: <b>${escapeHtml(createdByName)}</b>\n` +
    `• prioridade: ${badgePriority(prio)}\n` +
    `• pedido: ${officeSignalLabel(state)}\n` +
    (byEmail ? `• por: <b>${escapeHtml(byEmail)}</b>\n` : "") +
    (comment ? `\n<b>Comentário:</b>\n${escapeHtml(comment)}\n` : "") +
    `\n<b>Mensagem original:</b>\n${escapeHtml(msg)}`;

  await tgSendMessage(MASTER_CHAT_ID, text, {
    reply_markup: masterKeyboard(taskId),
  });
}

// =========================
// ✅ Office API: signal task (SEM LOCK)
// payload: { taskId, state, comment?, by? {uid,email} }
app.post("/office/signal", requireOfficeAuth, async (req, res) => {
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
      audit: FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: byUid, name: byEmail },
        action: "office_signal",
        meta: { state: stateStr, hasComment: !!commentStr },
      }),
    });

    const updated = (await ref.get()).data() || {};

    await notifyMasterAboutOfficeSignal({
      taskId: taskIdStr,
      t: updated,
      state: stateStr,
      comment: commentStr,
      byEmail,
    });

    await refreshOfficeCard(taskIdStr).catch(() => {});

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

    return res.json({ ok: true, toast });
  } catch (e) {
    console.error("office/signal error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ⛔ Continua na PARTE 3/4
// index.js — MASTER-ONLY FINALIZE (PARTE 3/4)

// =========================
// Commands (/start, /id, /link)
// =========================
async function handleCommand(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = (message.text || "").trim();

  if (text === "/start") {
    await tgSendMessage(
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
    await tgSendMessage(chatId, info);
    return true;
  }

  // vínculo: /link TOKEN (sempre permitido)
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

    if (!expiresAt || new Date() > expiresAt) {
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

    await tgSendMessage(
      chatId,
      "✅ <b>Telegram vinculado com sucesso!</b>\nAgora você já pode usar o bot neste chat."
    );
    return true;
  }

  return false;
}

// =========================
// Incoming message handler
// =========================
async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || "";
  if (!text) return;

  // comandos passam sempre (inclui /link)
  if (text.startsWith("/")) {
    const handled = await handleCommand(message);
    if (handled) return;
  }

  // 🔒 auth lock
  const authCheck = await ensureTelegramLinkedOrThrow(message);
  if (!authCheck.ok) {
    const reason = authCheck.reason || "not_linked";

    if (reason === "chat_mismatch") {
      await tgSendMessage(
        chatId,
        "🔒 <b>Acesso restrito</b>\n\n" +
          "Seu Telegram está vinculado em <b>outro chat</b>.\n" +
          "Abra o chat correto ou gere um novo token no painel.\n\n" +
          "<code>/link SEU_TOKEN</code>"
      );
      return;
    }

    if (reason === "not_allowed") {
      await tgSendMessage(chatId, "🚫 <b>Acesso desativado</b> (usuário inativo/sem permissão).");
      return;
    }

    await tgSendMessage(
      chatId,
      "🔒 <b>Acesso restrito</b>\n\n" +
        "Faça login no painel e vincule seu Telegram.\n" +
        "<code>/link SEU_TOKEN</code>"
    );
    return;
  }

  // 1) Master respondendo comentário?
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

  // 2) Escritório enviando detalhes (quando Master pediu)
  const awaiting = await popAwaiting(from.id);
  if (awaiting?.taskId) {
    await finalizeWithDetails(awaiting.taskId, from, text);
    await tgSendMessage(chatId, "✅ Detalhes salvos e tarefa finalizada.");
    return;
  }

  // 3) Criar nova tarefa
  const priority = inferPriority(text);
  const createdByName = userLabel(from);

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

  // posta no chat do escritório
  const officeMsg = await tgSendMessage(t.office.chatId, taskCardText(taskId, t), {
    reply_markup: officeKeyboard(taskId),
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

// ⛔ Continua na PARTE 4/4
// index.js — MASTER-ONLY FINALIZE (PARTE 4/4)

// =========================
// Save / finalize helpers
// =========================
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

  // atualiza card do escritório (remove teclado)
  if (updated.office?.chatId && updated.office?.messageId) {
    await tgEditMessage(updated.office.chatId, updated.office.messageId, taskCardText(taskId, updated), {
      reply_markup: { inline_keyboard: [] },
    });
  }

  // avisa solicitante
  const createdChatId = updated.createdBy?.chatId;
  if (createdChatId) {
    await tgSendMessage(
      createdChatId,
      `📣 Sua tarefa <code>${escapeHtml(taskId)}</code> foi concluída com detalhes.\n` +
        `📌 Status: ${badgeStatus(updated.status)}`
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

  // avisa escritório
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

// =========================
// Callback handler
// =========================
function isMasterCallback(cb) {
  const chatId = cb?.message?.chat?.id;
  return String(chatId || "") === String(MASTER_CHAT_ID);
}

async function handleCallback(cb) {
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

  const t = snap.data() || {};
  const operatorName = userLabel(cb.from);
  const officeChatId = t.office?.chatId;
  const officeMessageId = t.office?.messageId;

  // ===== Office priority only =====
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
        reply_markup: isClosedStatus(updated.status) ? { inline_keyboard: [] } : officeKeyboard(taskId),
      });
    }
    return;
  }

  // Office: botão "enviar ações pro master"
  if (action === "to_master") {
    // só aceita se veio do chat do escritório, quando houver officeChatId
    if (cb.message?.chat?.id && officeChatId && String(cb.message.chat.id) !== String(officeChatId)) return;

    await tgSendMessage(
      MASTER_CHAT_ID,
      `📨 <b>Ações do Master</b>\n` +
        `🧾 Tarefa: <code>${escapeHtml(taskId)}</code>\n` +
        `Solicitado pelo escritório.\n\n` +
        `Use os botões abaixo para decidir:`,
      { reply_markup: masterKeyboard(taskId) }
    );
    return;
  }

  // ===== Master =====
  if (action === "mstatus") {
    if (!isMasterCallback(cb)) return;
    if (!["pendente", "feito", "deu_ruim"].includes(value)) return;

    const closing = value === "feito" || value === "deu_ruim";

    await ref.update({
      status: value,
      closedAt: closing ? nowTS() : null,
      closedBy: { userId: cb.from.id, name: operatorName, via: "master" },
      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "master_status",
        meta: { status: value },
      }),
    });

    await refreshOfficeCard(taskId);

    const updated = (await ref.get()).data();

    // avisa solicitante
    const createdChatId = updated.createdBy?.chatId;
    if (createdChatId) {
      await tgSendMessage(
        createdChatId,
        `📣 Sua tarefa <code>${escapeHtml(taskId)}</code> foi atualizada pelo Master:\n` +
          `📌 Status: ${badgeStatus(updated.status)}\n` +
          `⚡ Prioridade: ${badgePriority(updated.priority)}`
      );
    }

    // avisa escritório
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

  // Master: responder
  if (action === "mcomment") {
    if (!isMasterCallback(cb)) return;

    await setAwaitingMaster(cb.from.id, taskId);

    await tgSendMessage(
      MASTER_CHAT_ID,
      `💬 <b>Responder tarefa</b>\n` +
        `🧾 Tarefa: <code>${escapeHtml(taskId)}</code>\n` +
        `Envie UMA mensagem com sua resposta.`
    );
    return;
  }

  // Master: pedir detalhes (vai fazer o operador do escritório responder com 1 msg)
  if (action === "mdetails") {
    if (!isMasterCallback(cb)) return;

    // marca como "feito_detalhes pendente" pedindo resposta do escritório (quem clicar no chat do office)
    // estratégia simples: manda instrução no chat do escritório e seta awaiting para o user que clicar.
    if (officeChatId) {
      await tgSendMessage(
        officeChatId,
        `📝 <b>Master pediu detalhes</b>\n` +
          `Tarefa <code>${escapeHtml(taskId)}</code>\n` +
          `Responda com UMA mensagem contendo os detalhes para finalizar.`
      );
    }
    return;
  }
}

// =========================
// Telegram Webhook
// =========================
app.post("/telegram/webhook", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) {
      return res.status(401).send("unauthorized");
    }

    const update = req.body || {};

    if (update.callback_query) await handleCallback(update.callback_query);
    if (update.message) await handleMessage(update.message);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("telegram webhook error:", e?.message || e);
    // sempre 200 pro Telegram não ficar repetindo
    return res.status(200).send("ok");
  }
});

// =========================
// Health
// =========================
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
      mode: RUN_MODE,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// Webhook control (manual)
// =========================
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

// =========================
// Boot (Render)
// =========================
const listenPort = Number(PORT || 8080);

app.listen(listenPort, () => {
  console.log("✅ VeroTasks Backend online");
  console.log(`→ Port: ${listenPort}`);
  console.log(`→ BASE_URL: ${BASE_URL}`);
  console.log(`→ OFFICE_CHAT_ID: ${OFFICE_CHAT_ID || "(mesmo chat do solicitante)"}`);
  console.log(`→ MASTER_CHAT_ID: ${MASTER_CHAT_ID}`);
  console.log(`→ MODE: ${RUN_MODE}`);
  console.log("→ AUTH_LOCK: ON (requires /link + chat match + role/status)");
});
