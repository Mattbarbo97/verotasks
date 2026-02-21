// bot.js
import { Telegraf, Markup } from "telegraf";
import admin from "firebase-admin";

const {
  TELEGRAM_BOT_TOKEN,
  MASTER_CHAT_ID,

  MASTER_API_SECRET, // usado pra chamar /master/respond
  API_BASE_URL, // ex: https://seu-backend.onrender.com

  FIREBASE_SERVICE_ACCOUNT_JSON,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!MASTER_CHAT_ID) throw new Error("Missing MASTER_CHAT_ID");
if (!MASTER_API_SECRET) throw new Error("Missing MASTER_API_SECRET");
if (!API_BASE_URL) throw new Error("Missing API_BASE_URL");
if (!FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON)),
  });
}
const db = admin.firestore();

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// -----------------------------------------
// Helpers
// -----------------------------------------
function safeStr(x, max = 1200) {
  if (!x) return "";
  const s = String(x);
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeOfficeSignal(sig) {
  // Suporta string (legado) e objeto {state, comment}
  if (!sig) return { state: "", comment: "" };
  if (typeof sig === "string") return { state: sig, comment: "" };
  if (typeof sig === "object") {
    return {
      state: safeStr(sig.state || "", 60),
      comment: safeStr(sig.comment || "", 1200),
    };
  }
  return { state: "", comment: "" };
}

function normalizePriority(p) {
  const s = String(p || "").toLowerCase().trim();
  if (s === "urgente") return "urgente";
  if (s === "alta") return "alta";
  if (s === "baixa") return "baixa";
  return "media";
}

function prBadge(p) {
  const pr = normalizePriority(p);
  if (pr === "urgente") return "🔴 URGENTE";
  if (pr === "alta") return "🟠 ALTA";
  if (pr === "baixa") return "🟢 BAIXA";
  return "🟡 MÉDIA";
}

function isClosedStatus(status) {
  return ["feito", "feito_detalhes", "deu_ruim"].includes(String(status || ""));
}

function toMs(ts) {
  try {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    return 0;
  } catch {
    return 0;
  }
}

function taskPreview(data) {
  return (
    safeStr(data?.message, 120) ||
    safeStr(data?.description, 120) ||
    safeStr(data?.title, 120) ||
    safeStr(data?.telegram?.cleanText, 120) ||
    safeStr(data?.telegram?.rawText, 120) ||
    "—"
  );
}

function taskText(taskId, data) {
  const title = safeStr(data.title || "", 160);
  const preview = taskPreview(data);

  const status = safeStr(data.status || "aberta", 40);
  const priority = prBadge(data.priority);

  const createdBy = safeStr(data?.createdBy?.name || data?.by?.name || "", 120) || "—";

  const sig = normalizeOfficeSignal(data.officeSignal);
  const sigState = sig.state || "—";
  const sigComment = sig.comment || safeStr(data.officeComment || "", 900);

  const officeAt = toMs(data.officeSignaledAt);
  const createdAt = toMs(data.createdAt);

  let msg = `🧾 *Tarefa*\n`;
  msg += `• ID: \`${taskId}\`\n`;
  msg += `• Prioridade: *${priority}*\n`;
  msg += `• De: *${safeStr(createdBy, 120)}*\n`;
  msg += `• Status: *${status}*\n`;
  msg += `\n📝 *${title || preview}*\n`;

  msg += `\n🚦 *Sinal do escritório:* *${safeStr(sigState, 80)}*\n`;
  if (sigComment) msg += `💬 *Comentário:* ${safeStr(sigComment, 900)}\n`;

  if (officeAt) msg += `\n🕒 officeSignaledAt(ms): \`${officeAt}\`\n`;
  if (createdAt) msg += `🕒 createdAt(ms): \`${createdAt}\`\n`;

  return msg;
}

function buttons(taskId) {
  // Ações canon do seu app
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ FEITO", `act|feito|${taskId}`),
      Markup.button.callback("🧾 FEITO (det.)", `act|feito_detalhes|${taskId}`),
    ],
    [Markup.button.callback("⏳ PENDENTE", `act|pendente|${taskId}`)],
    [Markup.button.callback("🚫 DEU RUIM", `act|deu_ruim|${taskId}`)],
    [Markup.button.callback("💬 COMENTAR", `act|comentario|${taskId}`)],
  ]);
}

async function callMasterRespond({ taskId, action, note, telegramMessageId }) {
  const res = await fetch(`${API_BASE_URL}/master/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Secret": MASTER_API_SECRET,
    },
    body: JSON.stringify({ taskId, action, note, telegramMessageId }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `http_${res.status}`);
  }
  return json;
}

function isMasterChat(ctx) {
  // MASTER_CHAT_ID pode ser string; ctx.chat.id é number
  return String(ctx?.chat?.id || "") === String(MASTER_CHAT_ID);
}

// -----------------------------------------
// 1) Comando /start
// -----------------------------------------
bot.start(async (ctx) => {
  if (!isMasterChat(ctx)) {
    await ctx.reply("🚫 Acesso restrito.");
    return;
  }
  await ctx.reply("✅ Master bot online. Vou te avisar quando o escritório sinalizar tarefas.");
});

// -----------------------------------------
// 2) Callback dos botões
// -----------------------------------------
const pendingReply = new Map(); // chatId -> { taskId, action }

bot.on("callback_query", async (ctx) => {
  try {
    if (!isMasterChat(ctx)) {
      await ctx.answerCbQuery("Acesso restrito.", { show_alert: true }).catch(() => {});
      return;
    }

    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("act|")) return;

    const [, action, taskId] = data.split("|");
    await ctx.answerCbQuery().catch(() => {});

    if (!taskId) {
      await ctx.reply("⚠️ Falha: taskId ausente.");
      return;
    }

    if (action === "comentario") {
      pendingReply.set(ctx.chat.id, { taskId, action });
      await ctx.reply(`💬 Envie a mensagem para registrar na tarefa \`${taskId}\``, {
        parse_mode: "Markdown",
      });
      return;
    }

    await callMasterRespond({
      taskId,
      action,
      note: "",
      telegramMessageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.reply(`✅ Ação registrada: *${action}* em \`${taskId}\``, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("❌ callback_query", e);
    await ctx.reply("🚨 Falha ao registrar ação. Verifica logs do Render/bot.");
  }
});

// -----------------------------------------
// 3) Texto após clicar “💬 comentar”
// -----------------------------------------
bot.on("text", async (ctx) => {
  if (!isMasterChat(ctx)) return;

  const p = pendingReply.get(ctx.chat.id);
  if (!p) return;

  pendingReply.delete(ctx.chat.id);

  try {
    const note = safeStr(ctx.message?.text || "", 2000);
    await callMasterRespond({
      taskId: p.taskId,
      action: "comentario",
      note,
    });

    await ctx.reply(`💬 Comentário registrado na tarefa \`${p.taskId}\``, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("❌ master comment", e);
    await ctx.reply("🚨 Falha ao registrar comentário. Verifica logs.");
  }
});

// -----------------------------------------
// 4) Listener Firestore: dispara pro Master quando OFFICE sinalizar
// -----------------------------------------
function startTaskListener() {
  // Observa as últimas tarefas; para não perder sinais muito antigos, aumente o limit.
  const ref = db.collection("tasks").orderBy("createdAt", "desc").limit(200);

  let ready = false;

  // Cache dedupe: taskId -> lastHash
  const lastHashByTask = new Map();

  ref.onSnapshot(
    async (snap) => {
      if (!ready) {
        ready = true;
        return;
      }

      for (const ch of snap.docChanges()) {
        if (ch.type !== "modified" && ch.type !== "added") continue;

        const doc = ch.doc;
        const taskId = doc.id;
        const data = doc.data() || {};

        // Não notifica se já estiver fechado
        if (isClosedStatus(data.status)) continue;

        // Só notifica quando houver sinal real do escritório
        const sig = normalizeOfficeSignal(data.officeSignal);
        const officeAtMs = toMs(data.officeSignaledAt);
        const hasSignal = Boolean(sig.state) || Boolean(sig.comment) || Boolean(officeAtMs);
        if (!hasSignal) continue;

        // Dedupe: evita notificar em qualquer alteração que não seja sinal novo
        const hash = [
          taskId,
          String(officeAtMs || 0),
          safeStr(sig.state, 80),
          safeStr(sig.comment, 200),
          safeStr(data.officeComment || "", 200),
        ].join("|");

        const prevHash = lastHashByTask.get(taskId) || "";
        if (hash === prevHash) continue;
        lastHashByTask.set(taskId, hash);

        const text = taskText(taskId, data);

        try {
          await bot.telegram.sendMessage(MASTER_CHAT_ID, text, {
            parse_mode: "Markdown",
            ...buttons(taskId),
          });
        } catch (e) {
          console.error("❌ sendMessage", e);
        }
      }
    },
    (err) => console.error("❌ Firestore listener error", err)
  );
}

startTaskListener();

// -----------------------------------------
// Start bot
// -----------------------------------------
bot.launch().then(() => console.log("✅ Telegram bot launched"));

// Render shutdown
process.once("SIGTERM", () => bot.stop("SIGTERM"));
process.once("SIGINT", () => bot.stop("SIGINT"));
