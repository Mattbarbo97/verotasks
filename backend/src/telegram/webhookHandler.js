// backend/src/telegram/webhookHandler.js
const { collections } = require("../firebase/collections");
const { nowTS } = require("../services/awaiting");

function safeText(v) {
  return String(v || "").trim();
}

function isAuthLockOn(cfg) {
  return String(cfg.AUTH_LOCK || "").toUpperCase() === "ON";
}

async function sendText(tg, chatId, text, opts = {}) {
  if (!chatId) return null;
  return tg.post("/sendMessage", { chat_id: chatId, text, ...opts });
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

function parsePriorityCommand(text) {
  const t = safeText(text);
  const m = t.match(/^\/(?:p|prioridade)\s+(baixa|media|m[eé]dia|alta|urgente|critica|cr[ií]tica)\s*$/i);
  if (!m) return null;
  return normalizePriority(m[1]);
}

function detectPriorityFromText(text) {
  const t = safeText(text).toLowerCase();
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

function pickPriority(text) {
  return parsePriorityCommand(text) || detectPriorityFromText(text);
}

function buildTitle(text) {
  const t = safeText(text);
  if (!t) return "Solicitação via Telegram";
  const cleaned = t.replace(/^\/(?:p|prioridade)\s+\S+\s*/i, "").trim();
  return (cleaned || t).slice(0, 80);
}

function priorityBadge(p) {
  const pr = normalizePriority(p);
  if (pr === "urgente") return "🚨 URGENTE";
  if (pr === "alta") return "🔥 ALTA";
  if (pr === "baixa") return "🟢 BAIXA";
  return "🟡 MÉDIA";
}

// rate limit simples (anti-flood)
const RL = new Map();
function hitRateLimit(key, minIntervalMs) {
  const now = Date.now();
  const cur = RL.get(key) || { lastMs: 0 };
  if (now - cur.lastMs < minIntervalMs) return true;
  RL.set(key, { lastMs: now });
  return false;
}

async function handleUpdate(tg, cfg, req, res) {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message || null;
    if (!msg) return res.json({ ok: true });

    const chatId = msg?.chat?.id;
    const fromId = msg?.from?.id;
    const text = safeText(msg?.text);

    if (!chatId) return res.json({ ok: true });

    // webhook secret (se usar)
    if (cfg.TELEGRAM_WEBHOOK_SECRET) {
      const secretHeader =
        req.headers["x-telegram-bot-api-secret-token"] ||
        req.headers["X-Telegram-Bot-Api-Secret-Token"];
      if (secretHeader && String(secretHeader) !== String(cfg.TELEGRAM_WEBHOOK_SECRET)) {
        return res.status(401).json({ ok: false });
      }
    }

    const lockOn = isAuthLockOn(cfg);
    const masterChatId = String(cfg.MASTER_CHAT_ID || "").trim(); // Wendell
    const officeChatId = String(cfg.OFFICE_CHAT_ID || "").trim();

    const { usersCol, tasksCol, linkTokensCol } = collections();

    // /start /help
    if (text === "/start" || text === "/help") {
      await sendText(
        tg,
        chatId,
        "✅ VeroBot\n\nEnvie a solicitação normalmente.\n\nPrioridade:\n/p baixa | /p media | /p alta | /p urgente\n\nEx:\n/p urgente\nSistema travou!"
      );
      return res.json({ ok: true });
    }

    // anti-flood
    if (fromId && hitRateLimit(`u:${fromId}`, 2500)) {
      await sendText(tg, chatId, "⏳ Aguarde 2s e tente novamente.");
      return res.json({ ok: true });
    }

    // LOCK ON (mantém restrito)
    if (lockOn) {
      const linkedSnap = await usersCol.where("telegramChatId", "==", chatId).limit(1).get();
      const isLinked = !linkedSnap.empty;

      const linkMatch = text.match(/^\/link(?:@[\w_]+)?\s+(\S+)\s*$/i);
      if (!isLinked && linkMatch && linkMatch[1]) {
        const tokenId = String(linkMatch[1]).trim();
        if (!linkTokensCol) {
          await sendText(tg, chatId, "❌ Vinculação indisponível agora.");
          return res.json({ ok: true });
        }
        const tokenRef = linkTokensCol.doc(tokenId);
        const tokenSnap = await tokenRef.get();
        if (!tokenSnap.exists) {
          await sendText(tg, chatId, "❌ Token inválido. Gere outro no painel.");
          return res.json({ ok: true });
        }
        const tokenDoc = tokenSnap.data() || {};
        if (tokenDoc.consumedAt) {
          await sendText(tg, chatId, "⚠️ Token já usado. Gere outro no painel.");
          return res.json({ ok: true });
        }
        const uid = String(tokenDoc.uid || "").trim();
        if (!uid) {
          await sendText(tg, chatId, "❌ Token inválido (sem UID).");
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
          {
            consumedAt: nowTS(),
            consumedByChatId: chatId,
            consumedByUserId: fromId || null,
          },
          { merge: true }
        );

        await sendText(tg, chatId, "✅ Telegram vinculado!");
        return res.json({ ok: true });
      }

      if (!isLinked) {
        await sendText(
          tg,
          chatId,
          "🔒 Acesso restrito.\n\nFaça login no painel e vincule:\n/link SEU_TOKEN"
        );
        return res.json({ ok: true });
      }

      await sendText(tg, chatId, "✅ Ok! Envie sua solicitação.");
      return res.json({ ok: true });
    }

    // ============================
    // MODO PÚBLICO (LOCK OFF)
    // ============================
    const pr = pickPriority(text);
    const badge = priorityBadge(pr);
    const title = buildTitle(text);
    const userLabel = fmtUserLabel(msg);

    // 🔥 Campos que o OfficePanel costuma ler:
    // - message (não ficar "(sem mensagem)")
    // - by / createdBy (não ficar "De: —")
    const by = {
      uid: `tg:${fromId || "unknown"}`,
      name: userLabel,
      email: null,
      source: "telegram",
    };

    let createdId = null;

    if (tasksCol) {
      const docRef = await tasksCol.add({
        // UI: mensagem + autor
        message: text || "",
        by,
        createdBy: by,

        // extras
        title,
        description: text || "",

        priority: normalizePriority(pr),
        status: "aberta",

        officeSignal: null,
        officeComment: "",

        createdAt: nowTS(),
        updatedAt: nowTS(),

        source: "telegram_public",
        telegram: {
          fromId: fromId || null,
          chatId,
          userLabel,
          rawText: text || "",
        },
      });

      createdId = docRef?.id || null;
    }

    // encaminha pro MASTER e pro OFFICE (Telegram)
    const payloadHtml =
      `📩 <b>${badge}</b>\n` +
      `<b>Tarefa:</b> ${title}\n` +
      `<b>De:</b> ${userLabel}\n\n` +
      `<b>Mensagem:</b>\n${text || "(sem texto)"}\n` +
      (createdId ? `\n<b>ID:</b> <code>${createdId}</code>\n` : "");

    if (masterChatId) await sendText(tg, masterChatId, payloadHtml, { parse_mode: "HTML" });
    if (officeChatId) await sendText(tg, officeChatId, payloadHtml, { parse_mode: "HTML" });

    // responde pro usuário
    const reply =
      `✅ Recebido! Já enviei para o escritório.\n\n` +
      `📌 Prioridade: ${badge}\n` +
      (createdId ? `🧾 Protocolo: ${createdId}\n\n` : "\n") +
      `Para definir prioridade, envie:\n` +
      `/p baixa | /p media | /p alta | /p urgente`;

    await sendText(tg, chatId, reply);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram][webhookHandler] error:", err);
    return res.status(200).json({ ok: true });
  }
}

module.exports = { handleUpdate };
