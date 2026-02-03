// bot.js
import { Telegraf, Markup } from "telegraf";
import admin from "firebase-admin";

const {
  TELEGRAM_BOT_TOKEN,
  MASTER_CHAT_ID,

  MASTER_API_SECRET,          // usado pra chamar /master/respond
  API_BASE_URL,               // ex: https://seu-backend.onrender.com

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

function taskText(taskId, data) {
  const title = safeStr(data.title || "—", 200);
  const signal = data.officeSignal || "—";
  const note = safeStr(data.officeNote || "", 800);

  const status = data.status || "aberta";
  const masterNote = safeStr(data.masterNote || "", 800);

  let msg = `🧾 *Tarefa*\n`;
  msg += `• ID: \`${taskId}\`\n`;
  msg += `• Título: *${title}*\n`;
  msg += `• Sinal: *${signal}*\n`;
  if (note) msg += `• Nota: ${note}\n`;
  msg += `\n📌 Status atual: *${status}*\n`;
  if (masterNote) msg += `💬 Última resposta: ${masterNote}\n`;

  return msg;
}

function buttons(taskId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ concluir", `act|concluido|${taskId}`)],
    [Markup.button.callback("⏳ pendente", `act|pendente|${taskId}`)],
    [Markup.button.callback("🚫 deu ruim", `act|deu_ruim|${taskId}`)],
    [Markup.button.callback("💬 responder", `act|comentario|${taskId}`)],
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

// -----------------------------------------
// 1) Comando /start
// -----------------------------------------
bot.start(async (ctx) => {
  await ctx.reply("✅ Master bot online. Vou te avisar quando o escritório sinalizar tarefas.");
});

// -----------------------------------------
// 2) Callback dos botões
// -----------------------------------------
const pendingReply = new Map(); // chatId -> { taskId, action }

bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    if (!data.startsWith("act|")) return;

    const [, action, taskId] = data.split("|");
    await ctx.answerCbQuery();

    if (action === "comentario") {
      pendingReply.set(ctx.chat.id, { taskId, action });
      await ctx.reply(`💬 Manda a mensagem de resposta para a tarefa \`${taskId}\` (vai registrar no painel).`, {
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
// 3) Texto após clicar “💬 responder”
// -----------------------------------------
bot.on("text", async (ctx) => {
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

    await ctx.reply(`💬 Resposta registrada na tarefa \`${p.taskId}\``, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("❌ master comment", e);
    await ctx.reply("🚨 Falha ao registrar comentário. Verifica logs.");
  }
});

// -----------------------------------------
// 4) Listener Firestore: dispara pro Master quando sinal muda
// -----------------------------------------
function startTaskListener() {
  // Heurística simples: monitora tarefas “aberta” e manda quando officeSignal muda
  // Para produção, você pode refinar com campo "notifiedMasterAt" ou fila/outbox.
  const ref = db.collection("tasks").orderBy("createdAt", "desc").limit(50);

  let ready = false;
  ref.onSnapshot(
    async (snap) => {
      // evitar spam no boot
      if (!ready) {
        ready = true;
        return;
      }

      for (const ch of snap.docChanges()) {
        if (ch.type !== "modified" && ch.type !== "added") continue;

        const doc = ch.doc;
        const taskId = doc.id;
        const data = doc.data();

        // manda pro master quando houver sinal do office e status ainda não concluído
        const status = data.status || "aberta";
        if (status === "concluido") continue;

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
