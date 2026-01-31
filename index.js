require("dotenv").config();
const express = require("express");
const axios = require("axios");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  OFFICE_CHAT_ID,
  BASE_URL,
  PORT = 10000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_WEBHOOK_SECRET) throw new Error("Missing TELEGRAM_WEBHOOK_SECRET");
if (!BASE_URL) throw new Error("Missing BASE_URL");

// OFFICE_CHAT_ID pode ficar vazio por enquanto: fallback pro mesmo chat
// (assim você coloca o bot no ar antes de ter grupo do escritorio)
const hasOffice = !!OFFICE_CHAT_ID;

const tg = axios.create({
  baseURL: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`,
  timeout: 20000,
});

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- helpers ---
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function userName(from = {}) {
  return (
    [from.first_name, from.last_name].filter(Boolean).join(" ") ||
    from.username ||
    String(from.id || "Usuario")
  );
}

function inferPriority(text = "") {
  const t = text.toLowerCase();
  if (["urgente", "agora", "parou", "quebrou", "cliente", "hoje"].some((w) => t.includes(w))) return "alta";
  if (["depois", "quando der", "amanha", "amanhã", "sem pressa"].some((w) => t.includes(w))) return "baixa";
  return "media";
}

function badgePriority(p) {
  if (p === "alta") return "🔴 ALTA";
  if (p === "baixa") return "🟢 BAIXA";
  return "🟡 MEDIA";
}

function badgeStatus(s) {
  const map = {
    aberta: "🆕 ABERTA",
    pendente: "⏳ PENDENTE",
    feito: "✅ FEITO",
    feito_detalhes: "📝 FEITO (DETALHES)",
    deu_ruim: "🚫 DEU RUIM",
  };
  return map[s] || s;
}

function cardText(id, t) {
  return (
    `🧾 <b>Tarefa #${id}</b>\n` +
    `👤 ${escapeHtml(t.from)}\n` +
    `⚡ Prioridade: ${badgePriority(t.priority)}\n` +
    `📌 Status: <b>${escapeHtml(badgeStatus(t.status))}</b>\n\n` +
    `📝 ${escapeHtml(t.text)}` +
    (t.details ? `\n\n<b>Detalhes:</b>\n${escapeHtml(t.details)}` : "")
  );
}

function mainKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Feito", callback_data: `status:${id}:feito` },
        { text: "📝 Feito c/ detalhes", callback_data: `status:${id}:feito_detalhes` },
      ],
      [
        { text: "⏳ Pendente", callback_data: `status:${id}:pendente` },
        { text: "🚫 Deu ruim", callback_data: `status:${id}:deu_ruim` },
      ],
      [
        { text: "🔴 Alta", callback_data: `prio:${id}:alta` },
        { text: "🟡 Media", callback_data: `prio:${id}:media` },
        { text: "🟢 Baixa", callback_data: `prio:${id}:baixa` },
      ],
    ],
  };
}

// memoria temporaria (pra hoje): tarefas + aguardando detalhes
const tasks = new Map(); // id -> task
const awaitingDetails = new Map(); // userId -> taskId

async function sendMessage(chat_id, text, opts = {}) {
  const { data } = await tg.post("/sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    ...opts,
  });
  if (!data.ok) throw new Error(`sendMessage failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function editMessageText(chat_id, message_id, text, opts = {}) {
  const { data } = await tg.post("/editMessageText", {
    chat_id,
    message_id,
    text,
    parse_mode: "HTML",
    ...opts,
  });
  if (!data.ok) throw new Error(`editMessageText failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function answerCallbackQuery(callback_query_id) {
  const { data } = await tg.post("/answerCallbackQuery", { callback_query_id });
  if (!data.ok) throw new Error(`answerCallbackQuery failed: ${JSON.stringify(data)}`);
}

// --- webhook security ---
function verifySecret(req) {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  return secret === TELEGRAM_WEBHOOK_SECRET;
}

// --- routes ---
app.get("/", (_, res) => res.status(200).send("ok"));

app.post("/telegram/webhook", async (req, res) => {
  try {
    if (!verifySecret(req)) return res.status(401).send("unauthorized");

    const update = req.body;

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return res.status(200).send("ok");
    }

    if (update.message) {
      await handleMessage(update.message);
      return res.status(200).send("ok");
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err?.message || err, err?.response?.data);
    return res.status(200).send("ok");
  }
});

// endpoint pra setar webhook (uma vez)
app.post("/telegram/setWebhook", async (req, res) => {
  try {
    const url = `${BASE_URL}/telegram/webhook`;
    const { data } = await tg.post("/setWebhook", {
      url,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message, details: e?.response?.data });
  }
});

// --- handlers ---
async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || "";

  if (!text) return;

  // se estiver aguardando detalhes
  const pendingTaskId = awaitingDetails.get(from.id);
  if (pendingTaskId) {
    const task = tasks.get(pendingTaskId);
    if (task) {
      task.details = text;
      task.status = "feito_detalhes";
      task.closedBy = userName(from);
      awaitingDetails.delete(from.id);

      // atualiza card no escritorio
      await editMessageText(task.officeChatId, task.officeMessageId, cardText(pendingTaskId, task), {
        reply_markup: { inline_keyboard: [] },
      });

      // avisa quem pediu
      await sendMessage(task.createdChatId, `✅ Sua tarefa #${pendingTaskId} foi concluida com detalhes.`);
    }
    return;
  }

  // cria tarefa
  const id = Date.now().toString().slice(-6);
  const task = {
    id,
    text,
    from: userName(from),
    priority: inferPriority(text),
    status: "aberta",
    details: "",
    createdChatId: chatId,
    officeChatId: hasOffice ? Number(OFFICE_CHAT_ID) : chatId,
    officeMessageId: null,
    closedBy: null,
  };

  tasks.set(id, task);

  await sendMessage(chatId, `✅ Tarefa registrada. ID: <code>${id}</code>`);

  // manda pro escritorio (ou pro mesmo chat se OFFICE_CHAT_ID vazio)
  const officeMsg = await sendMessage(task.officeChatId, cardText(id, task), {
    reply_markup: mainKeyboard(id),
  });

  task.officeMessageId = officeMsg.message_id;
}

async function handleCallback(cb) {
  const data = cb.data || "";
  const cbId = cb.id;

  await answerCallbackQuery(cbId);

  const [type, id, value] = data.split(":");
  const task = tasks.get(id);
  if (!task) return;

  const operator = userName(cb.from);

  if (type === "prio") {
    if (!["alta", "media", "baixa"].includes(value)) return;
    task.priority = value;
  }

  if (type === "status") {
    if (!["pendente", "feito", "feito_detalhes", "deu_ruim"].includes(value)) return;

    if (value === "feito_detalhes") {
      task.status = "feito_detalhes";
      task.closedBy = operator;
      awaitingDetails.set(cb.from.id, id);

      // pede detalhes no chat do escritorio
      await sendMessage(task.officeChatId, `📝 Responda com os detalhes da tarefa #${id} (uma mensagem).`);
    } else {
      task.status = value;
      task.closedBy = operator;

      // se finalizou (feito/deu_ruim), remove botoes
      if (value === "feito" || value === "deu_ruim") {
        await editMessageText(task.officeChatId, task.officeMessageId, cardText(id, task), {
          reply_markup: { inline_keyboard: [] },
        });
        await sendMessage(task.createdChatId, `📣 Sua tarefa #${id} foi atualizada: ${badgeStatus(task.status)}`);
        return;
      }
    }
  }

  // atualiza mensagem do escritorio com botoes ainda ativos
  await editMessageText(task.officeChatId, task.officeMessageId, cardText(id, task), {
    reply_markup: mainKeyboard(id),
  });
}

app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`OFFICE_CHAT_ID: ${OFFICE_CHAT_ID || "(nao definido - usando mesmo chat)"}`);
});
