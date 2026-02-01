// index.js (FULL)
// ✅ Correções principais nesta versão:
// - LOG detalhado quando Telegram retorna 400 (mostra response.data)
// - TRUNCAMENTO defensivo (evita erro "message is too long")
// - /office/signal NÃO retorna 500 por falha no Telegram (salva e responde ok, telegramOk=false)
// - notifiedAt só é setado APÓS o Telegram enviar com sucesso (não queima cooldown se der erro)
// - mantém compat com legado (officeComment, officeSignaledAt)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

/**
 * VeroTasks Backend (Render)
 * - Telegram webhook (tarefas + botões)
 * - Office API (/office/signal) protegido por secret
 * - Admin API (/admin/createUser) protegido por secret
 * - TV endpoint (/tv/tasks) com filtro
 * - Health endpoint (/health)
 *
 * ENV obrigatórias:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_WEBHOOK_SECRET
 * - BASE_URL
 * - FIREBASE_SERVICE_ACCOUNT  (JSON do service account)
 * - MASTER_CHAT_ID            (chat_id do privado do master)
 * - OFFICE_API_SECRET         (secret para o painel Office sinalizar)
 * - ADMIN_API_SECRET          (secret para criar usuários)
 *
 * ENV opcionais:
 * - OFFICE_CHAT_ID            (chat_id do grupo do escritório)
 * - CORS_ORIGINS              (csv)
 * - PORT
 * - OFFICE_SIGNAL_COOLDOWN_SEC (janela anti-spam; default 90)
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
  OFFICE_SIGNAL_COOLDOWN_SEC,
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
const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const tasksCol = db.collection("tasks");

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

function isClosedStatus(status) {
  return ["feito", "feito_detalhes", "deu_ruim"].includes(String(status || ""));
}

// =========================
// TV filter helpers
// =========================
const TASK_STATUSES = ["aberta", "pendente", "feito", "feito_detalhes", "deu_ruim"];

function normalizeBucket(bucket) {
  const b = String(bucket || "").trim().toLowerCase();
  if (!b) return "pending";
  if (["pending", "pendentes", "abertas", "open"].includes(b)) return "pending";
  if (["closed", "finalizadas", "concluidas", "concluídas"].includes(b)) return "closed";
  if (["all", "todas", "tudo"].includes(b)) return "all";
  return "pending";
}

function parseTVFilter(q = {}) {
  const limit = Math.min(Number(q.limit || 50), 200);
  const statusRaw = String(q.status || "").trim().toLowerCase();
  const bucket = normalizeBucket(q.bucket);

  // prioridade: status explícito (refina dentro do bucket, se quiser)
  const status = TASK_STATUSES.includes(statusRaw) ? statusRaw : "";

  let statuses = null;
  if (bucket === "pending") statuses = ["aberta", "pendente"];
  if (bucket === "closed") statuses = ["feito", "feito_detalhes", "deu_ruim"];
  if (bucket === "all") statuses = null;

  // se status explícito, ele domina (vira filtro exato)
  if (status) statuses = [status];

  return { limit, bucket, status: status || null, statuses };
}

// =========================
// Office Signal (canônico + compat legado)
// =========================
const OFFICE_SIGNAL = {
  EM_ANDAMENTO: "em_andamento",
  PRECISO_AJUDA: "preciso_ajuda",
  APRESENTOU_PROBLEMAS: "apresentou_problemas",
  TAREFA_EXECUTADA: "tarefa_executada",
  COMENTARIO: "comentario",
};

function normalizeOfficeSignal(sig) {
  const s = String(sig || "").trim().toLowerCase();

  // legado -> novo
  if (s === "ajuda") return OFFICE_SIGNAL.PRECISO_AJUDA;
  if (s === "deu_ruim") return OFFICE_SIGNAL.APRESENTOU_PROBLEMAS;

  // novo (canônico)
  if (
    [
      OFFICE_SIGNAL.EM_ANDAMENTO,
      OFFICE_SIGNAL.PRECISO_AJUDA,
      OFFICE_SIGNAL.APRESENTOU_PROBLEMAS,
      OFFICE_SIGNAL.TAREFA_EXECUTADA,
      OFFICE_SIGNAL.COMENTARIO,
    ].includes(s)
  ) {
    return s;
  }

  // legado que ainda pode aparecer
  if (s === "em_andamento") return OFFICE_SIGNAL.EM_ANDAMENTO;
  if (s === "comentario") return OFFICE_SIGNAL.COMENTARIO;

  return null;
}

function badgeOfficeSignal(sig) {
  const s = normalizeOfficeSignal(sig);
  const map = {
    [OFFICE_SIGNAL.EM_ANDAMENTO]: "🛠️ <b>EM ANDAMENTO</b>",
    [OFFICE_SIGNAL.PRECISO_AJUDA]: "🆘 <b>PRECISO DE AJUDA</b>",
    [OFFICE_SIGNAL.APRESENTOU_PROBLEMAS]: "🚨 <b>APRESENTOU PROBLEMAS</b>",
    [OFFICE_SIGNAL.TAREFA_EXECUTADA]: "✅ <b>TAREFA EXECUTADA</b>",
    [OFFICE_SIGNAL.COMENTARIO]: "💬 <b>COMENTÁRIO</b>",
  };
  return map[s] || (sig ? `<b>${escapeHtml(String(sig))}</b>` : "—");
}

function getOfficeSignalFromTask(t = {}) {
  const os = t.officeSignal;

  // novo formato (objeto)
  if (os && typeof os === "object" && os.state) {
    const state = normalizeOfficeSignal(os.state);
    return {
      state: state || "",
      comment: safeStr(os.comment || ""),
      at: os.updatedAt || null,
      by: os.updatedBy || null,
      notifiedAt: os.notifiedAt || null,
      mode: "object",
    };
  }

  // legado (string)
  if (typeof os === "string" && os.trim()) {
    const state = normalizeOfficeSignal(os.trim());
    return {
      state: state || "",
      comment: safeStr(t.officeComment || ""),
      at: t.officeSignaledAt || null,
      by: null,
      notifiedAt: null,
      mode: "legacy",
    };
  }

  // legado sem officeSignal string, mas com officeComment/signaledAt
  if (t.officeSignaledAt || t.officeComment) {
    return {
      state: "",
      comment: safeStr(t.officeComment || ""),
      at: t.officeSignaledAt || null,
      by: null,
      notifiedAt: null,
      mode: "legacy",
    };
  }

  return null;
}

// =========================
// Anti-spam office signal
// =========================
const OFFICE_SIGNAL_COOLDOWN_MS =
  Math.max(10, Number(OFFICE_SIGNAL_COOLDOWN_SEC || 90)) * 1000;

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate) return ts.toDate().getTime();
  return 0;
}

function shouldNotifyOfficeSignal({ current, nextState, nextComment, taskStatus }) {
  const curState = String(current?.state || "");
  const curComment = String(current?.comment || "");
  const nextS = String(nextState || "");
  const nextC = String(nextComment || "");

  // 1) duplicado exato
  if (curState === nextS && curComment === nextC) {
    return { notify: false, reason: "duplicate" };
  }

  // 2) cooldown pela última notificação (se existir)
  const lastNotifiedMs = tsToMs(current?.notifiedAt);
  const nowMs = Date.now();
  if (lastNotifiedMs && nowMs - lastNotifiedMs < OFFICE_SIGNAL_COOLDOWN_MS) {
    return { notify: false, reason: "cooldown" };
  }

  // 3) se está aguardando decisão do master (tarefa aberta/pendente)
  // e já foi notificado sobre algo crítico, não spammar
  const isAwaitingDecision = !isClosedStatus(taskStatus);
  const critical = [OFFICE_SIGNAL.TAREFA_EXECUTADA, OFFICE_SIGNAL.APRESENTOU_PROBLEMAS];

  if (isAwaitingDecision && critical.includes(curState) && current?.notifiedAt) {
    return { notify: false, reason: "awaiting_master_decision" };
  }

  return { notify: true, reason: "ok" };
}

// =========================
// Text card
// =========================
function taskCardText(taskId, t) {
  const createdAt = t.createdAt?.toDate ? t.createdAt.toDate() : new Date();
  const createdAtStr = createdAt.toLocaleString("pt-BR");
  const msg = t.source?.text || "—";

  let detailsBlock = "";
  if (t.status === "feito_detalhes" && t.details) {
    detailsBlock = `\n\n<b>Detalhes:</b>\n${escapeHtml(t.details)}`;
  }

  // bloco do escritório (compat novo/legado)
  const sig = getOfficeSignalFromTask(t);
  let officeBlock = "";
  if (sig?.state) {
    const when = sig.at?.toDate ? sig.at.toDate().toLocaleString("pt-BR") : "—";
    officeBlock =
      `\n\n<b>Sinal do escritório:</b> ${badgeOfficeSignal(sig.state)}\n` +
      `<b>Em:</b> ${escapeHtml(when)}` +
      (sig.comment ? `\n<b>Comentário:</b>\n${escapeHtml(sig.comment)}` : "");
  }

  // último comentário do master (se existir)
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

// =========================
// Keyboards (Inline)
// =========================
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
// Helpers: refresh office card
// =========================
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

// =========================
// TV endpoint (Painel TV) — ✅ ÚNICO
// - ?bucket=pending|closed|all
// - ?status=aberta|pendente|feito|feito_detalhes|deu_ruim
// - ?limit=50
// =========================
app.get("/tv/tasks", async (req, res) => {
  try {
    const filter = parseTVFilter(req.query);

    let q = tasksCol.orderBy("createdAt", "desc");

    if (filter.statuses && filter.statuses.length) {
      q = q.where("status", "in", filter.statuses);
    }

    q = q.limit(filter.limit);

    const snap = await q.get();

    const items = [];
    snap.forEach((d) => {
      const x = d.data() || {};
      const sig = getOfficeSignalFromTask(x);

      items.push({
        id: d.id,
        createdAt: x.createdAt?.toDate ? x.createdAt.toDate().toISOString() : null,
        from: x.createdBy?.name || null,
        priority: x.priority,
        status: x.status,
        message: x.source?.text || "",

        officeSignal: sig?.state || "",
        officeComment: sig?.comment || "",
        officeSignaledAt: sig?.at?.toDate ? sig.at.toDate().toISOString() : null,
        officeNotifiedAt: sig?.notifiedAt?.toDate ? sig.notifiedAt.toDate().toISOString() : null,
      });
    });

    res.json({ ok: true, filter, items });
  } catch (e) {
    console.error("tv/tasks error:", e?.message || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// Office API: sinalizar tarefa (Web -> Bot -> Master)
// ✅ NOTA: notifiedAt só depois do Telegram enviar com sucesso
// =========================
app.post("/office/signal", requireOfficeAuth, async (req, res) => {
  try {
    const body = req.body || {};

    const taskId = body.taskId;
    const incomingState = body.state || body.signal;
    const comment = body.comment || "";
    const by = body.by || null;
    const byEmail = body.byEmail || by?.email || "";

    if (!taskId || !incomingState) {
      return res.status(400).json({ ok: false, error: "missing taskId/state" });
    }

    const nextState = normalizeOfficeSignal(incomingState);
    if (!nextState) {
      return res.status(400).json({ ok: false, error: "invalid signal" });
    }

    const nextComment = String(comment || "").slice(0, 2000);
    const nextBy = {
      uid: String(by?.uid || "office-web"),
      email: String(by?.email || byEmail || "office-web"),
    };

    const ref = tasksCol.doc(String(taskId));

    // ✅ transação evita corrida
    const txResult = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, code: 404, error: "task_not_found" };

      const t = snap.data() || {};
      const current = getOfficeSignalFromTask(t);

      const decision = shouldNotifyOfficeSignal({
        current,
        nextState,
        nextComment,
        taskStatus: t.status,
      });

      // duplicado = não escreve
      if (decision.reason === "duplicate") {
        return { ok: true, skipped: true, shouldNotify: false, reason: "duplicate" };
      }

      // sempre grava estado atualizado; NÃO seta notifiedAt aqui
      const nextOfficeSignalObj = {
        state: nextState,
        comment: nextComment,
        updatedAt: nowTS(),
        updatedBy: nextBy,
        // mantém valor anterior (se existir); só setamos depois que enviar ao Telegram
        notifiedAt: current?.notifiedAt || null,
      };

      tx.update(ref, {
        officeSignal: nextOfficeSignalObj,

        // legado
        officeComment: nextComment,
        officeSignaledAt: nowTS(),

        audit: admin.firestore.FieldValue.arrayUnion({
          at: nowTS(),
          by: { userId: "office", name: String(nextBy.email || "office-web") },
          action: "office_signal",
          meta: {
            signal: nextState,
            hasComment: Boolean(nextComment),
            shouldNotify: decision.notify,
            reason: decision.reason,
          },
        }),
      });

      return {
        ok: true,
        skipped: false,
        shouldNotify: decision.notify,
        reason: decision.reason,
        createdByName: safeStr(t.createdBy?.name) || "—",
        taskMessage: safeStr(t.source?.text) || "(sem mensagem)",
      };
    });

    if (!txResult.ok) {
      return res.status(txResult.code || 500).json({ ok: false, error: txResult.error || "error" });
    }

    // atualiza card do escritório (telegram)
    await refreshOfficeCard(String(taskId));

    // se não deve notificar, encerra aqui
    if (!txResult.shouldNotify) {
      return res.json({
        ok: true,
        notified: false,
        telegramOk: true,
        skipped: Boolean(txResult.skipped),
        reason: txResult.reason,
      });
    }

    // ✅ monta mensagem pro master (TRUNCADA)
    const taskMsgSafe = truncateText(escapeHtml(txResult.taskMessage), 1500);

    const masterText =
      `📣 <b>Escritório sinalizou</b>\n` +
      `🧾 <b>Tarefa:</b> <code>${escapeHtml(String(taskId))}</code>\n` +
      `👤 <b>Criada por:</b> ${escapeHtml(txResult.createdByName)}\n` +
      `🏢 <b>Quem sinalizou:</b> ${escapeHtml(nextBy.email)}\n\n` +
      `📝 <b>Mensagem da tarefa:</b>\n${taskMsgSafe}\n\n` +
      `🚦 <b>Sinal:</b> ${badgeOfficeSignal(nextState)}\n` +
      (nextComment ? `\n💬 <b>Comentário:</b>\n${escapeHtml(nextComment)}\n` : "") +
      `\nO que você quer fazer?`;

    // ✅ envia ao master; se falhar, NÃO derruba a rota
    try {
      await tgSendMessage(String(MASTER_CHAT_ID), masterText, {
        reply_markup: masterKeyboard(String(taskId)),
      });

      // ✅ só agora marca notifiedAt
      await ref.update({
        "officeSignal.notifiedAt": nowTS(),
      });

      return res.json({ ok: true, notified: true, telegramOk: true });
    } catch (e) {
      const info = telegramErrorInfo(e);

      // loga de forma útil no Render
      console.error("office/signal telegram error:", {
        taskId: String(taskId),
        masterChatId: String(MASTER_CHAT_ID),
        ...info,
      });

      // responde ok (estado já foi salvo)
      // e deixa o front decidir se mostra "não consegui notificar"
      return res.json({
        ok: true,
        notified: false,
        telegramOk: false,
        telegram: {
          status: info.status,
          error_code: info.error_code,
          description: info.description,
        },
      });
    }
  } catch (e) {
    console.error("office/signal error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// Admin API: create user  ✅ (ÚNICO)
// =========================
app.post("/admin/createUser", requireAdminAuth, async (req, res) => {
  try {
    const { email, password, name, role = "office" } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "missing_email_or_password" });
    }

    const user = await admin.auth().createUser({
      email: String(email).trim().toLowerCase(),
      password: String(password),
      displayName: name ? String(name).slice(0, 80) : undefined,
    });

    await admin.auth().setCustomUserClaims(user.uid, { role });

    await db.collection("users").doc(user.uid).set(
      {
        uid: user.uid,
        email: user.email,
        name: name ? String(name).slice(0, 80) : null,
        role,
        status: "active",
        createdAt: nowTS(),
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

// =========================
// Commands
// =========================
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
      `• chat_id: <code>${escapeHtml(chatId)}</code>\n` +
      `• type: <code>${escapeHtml(message.chat.type || "—")}</code>\n` +
      (message.chat.title ? `• title: <b>${escapeHtml(message.chat.title)}</b>\n` : "") +
      (from?.id ? `• user_id: <code>${escapeHtml(from.id)}</code>\n` : "");
    await tgSendMessage(chatId, info);
    return true;
  }

  return false;
}

// =========================
// Master validation
// =========================
function isMasterCallback(cb) {
  const chatId = cb?.message?.chat?.id;
  return String(chatId || "") === String(MASTER_CHAT_ID);
}

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

// =========================
// Callback handler
// =========================
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

  // MASTER callbacks
  if (action === "mstatus") {
    if (!isMasterCallback(cb)) return;
    if (!["pendente", "feito", "deu_ruim"].includes(value)) return;

    const closing = value === "feito" || value === "deu_ruim";

    await ref.update({
      status: value,
      closedAt: closing ? nowTS() : null,
      closedBy: { userId: cb.from.id, name: operatorName, via: "master" },

      // 🔒 limpa sinal do escritório após decisão do master
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

  // OFFICE callbacks
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
        `📝 <b>Detalhes necessários</b>\n` +
          `Tarefa <code>${escapeHtml(taskId)}</code>\n` +
          `Responda com UMA mensagem contendo os detalhes.`
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

      ...(closing
        ? { officeSignal: null, officeComment: "", officeSignaledAt: null }
        : {}),

      audit: admin.firestore.FieldValue.arrayUnion({
        at: nowTS(),
        by: { userId: cb.from.id, name: operatorName },
        action: "status",
        meta: { status: value },
      }),
    });

    const updated = (await ref.get()).data();

    await tgEditMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
      reply_markup: closing ? { inline_keyboard: [] } : mainKeyboard(taskId),
    });

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

// =========================
// Incoming message handler
// =========================
async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || "";

  if (!text) return;

  if (text.startsWith("/")) {
    const handled = await handleCommand(message);
    if (handled) return;
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
    await finalizeWithDetails(awaiting.taskId, from, text);
    await tgSendMessage(chatId, "✅ Detalhes salvos e tarefa finalizada.");
    return;
  }

  // 3️⃣ Criar nova tarefa
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

// =========================
// Telegram Webhook
// =========================
app.post("/telegram/webhook", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) {
      return res.status(401).send("unauthorized");
    }

    const update = req.body;

    if (update.callback_query) await handleCallback(update.callback_query);
    if (update.message) await handleMessage(update.message);

    res.status(200).send("ok");
  } catch (e) {
    console.error("telegram webhook error:", e?.message || e);
    res.status(200).send("ok");
  }
});

// =========================
// Health check (Render)
// =========================
app.get("/", (_, res) => res.status(200).send("ok"));

app.get("/health", async (_, res) => {
  try {
    await db.collection("_health").doc("ping").set({ at: nowTS() }, { merge: true });
    res.json({
      ok: true,
      service: "verotasks-backend",
      now: new Date().toISOString(),
      officeSignalCooldownSec: Math.round(OFFICE_SIGNAL_COOLDOWN_MS / 1000),
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
  console.log(`→ OFFICE_SIGNAL_COOLDOWN_SEC: ${Math.round(OFFICE_SIGNAL_COOLDOWN_MS / 1000)}`);
});
