// bot.js (DEMO em 30min) - Long Polling (sem webhook, sem Firebase)
// Requisitos: Node 18+ | npm i node-fetch dotenv

import "dotenv/config";
import fetch from "node-fetch";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Defina TELEGRAM_BOT_TOKEN no .env");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error("Telegram error:", json);
  return json;
}

function parseDemo(text) {
  // Formatos aceitos:
  // 1) /tarefa tema prioridade mensagem
  //    ex: /tarefa recepcao alta Levar docs pra sala 2
  // 2) #tema #alta mensagem
  //    ex: #recepcao #urgente Levar docs pra sala 2

  const raw = String(text || "").trim();
  if (!raw) return null;

  // /tarefa ...
  if (raw.toLowerCase().startsWith("/tarefa")) {
    const parts = raw.split(/\s+/);
    const theme = parts[1] || "geral";
    const priority = parts[2] || "normal";
    const message = parts.slice(3).join(" ").trim();
    if (!message) return null;
    return { theme, priority, message };
  }

  // hashtags
  const tokens = raw.split(/\s+/);
  const tags = tokens.filter((t) => t.startsWith("#")).map((t) => t.slice(1).toLowerCase());
  const message = tokens.filter((t) => !t.startsWith("#")).join(" ").trim();
  if (tags.length === 0 || !message) return null;

  let theme = "geral";
  let priority = "normal";

  for (const t of tags) {
    if (["urgente", "alta", "media", "média", "baixa", "normal"].includes(t)) {
      priority = t === "média" ? "media" : t;
    } else if (theme === "geral") {
      theme = t;
    }
  }

  return { theme, priority, message };
}

function priorityEmoji(p) {
  const pr = String(p || "").toLowerCase();
  if (pr === "urgente") return "🔴";
  if (pr === "alta") return "🟠";
  if (pr === "media" || pr === "média") return "🟡";
  if (pr === "baixa") return "🔵";
  return "⚪";
}

function fmt({ theme, priority, message }) {
  const em = priorityEmoji(priority);
  const th = theme ? `#${theme}` : "#geral";
  const pr = (priority || "normal").toUpperCase();
  const now = new Date().toLocaleString("pt-BR");
  return (
`✅ *DEMO — Tarefa recebida*
${em} *${pr}*  ${th}
📝 ${message}
🕒 ${now}

📺 (simulação) “Apareceu na TV agora”`
  );
}

let offset = 0;

async function main() {
  console.log("🤖 Bot DEMO rodando (long polling)...");
  console.log("➡️ Envie no Telegram:");
  console.log("   /tarefa recepcao alta Levar docs pra sala 2");
  console.log("   #financeiro #urgente Pagar boleto XPTO");
  console.log("   /start");

  while (true) {
    try {
      // long polling
      const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
      const data = await res.json();

      if (!data.ok) {
        console.error("getUpdates error:", data);
        await sleep(1500);
        continue;
      }

      for (const upd of data.result) {
        offset = upd.update_id + 1;

        const msg = upd.message;
        if (!msg?.text) continue;

        const chatId = msg.chat.id;
        const text = msg.text.trim();

        if (text === "/start") {
          await tg("sendMessage", {
            chat_id: chatId,
            text:
`✅ Bot DEMO online.

Teste assim:
1) /tarefa recepcao alta Levar docs pra sala 2
2) #financeiro #urgente Pagar boleto XPTO

Obs: Isso é DEMO (sem banco, sem TV real).`,
          });
          continue;
        }

        const parsed = parseDemo(text);
        if (!parsed) {
          await tg("sendMessage", {
            chat_id: chatId,
            text:
`Não entendi 😅

Use:
• /tarefa TEMA PRIORIDADE MENSAGEM
  ex: /tarefa recepcao alta Levar docs pra sala 2

ou:
• #tema #prioridade mensagem
  ex: #financeiro #urgente Pagar boleto XPTO`,
          });
          continue;
        }

        await tg("sendMessage", {
          chat_id: chatId,
          parse_mode: "Markdown",
          text: fmt(parsed),
        });
      }
    } catch (e) {
      console.error("loop error:", e);
      await sleep(1500);
    }
  }
}

main();

