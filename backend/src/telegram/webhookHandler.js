// backend/src/telegram/webhookHandler.js
const { collections } = require("../firebase/collections");
const { nowTS } = require("../services/awaiting");

// =========================================================
// Utils
// =========================================================
function safeText(v) {
  return String(v || "").trim();
}

function isAuthLockOn(cfg) {
  return String(cfg.AUTH_LOCK || "").toUpperCase() === "ON";
}

async function sendText(tg, chatId, text, opts = {}) {
  if (!chatId) return null;
  const payload = { chat_id: chatId, text, ...opts };
  return tg.post("/sendMessage", payload);
}

function fmtUserLabel(msg) {
  const u = msg?.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  const user = u.username ? `@${u.username}` : "";
  const id = u.id ? `id:${u.id}` : "";
  return [name || user || id || "desconhecido", user, id].filter(Boolean).join(" | ");
}

function fmtChatLabel(msg) {
  const c = msg?.chat || {};
  const title = c.title ? `“${c.title}”` : "";
  const id = c.id ? `chat:${c.id}` : "";
  const type = c.type ? `type:${c.type}` : "";
  return [title, id, type].filter(Boolean).join(" | ");
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
  // /p alta | /prioridade urgente
  const m = t.match(/^\/(?:p|prioridade)\s+(baixa|media|m[eé]dia|alta|urgente|critica|cr[ií]tica)\s*$/i);
  if (!m) return null;
  return normalizePriority(m[1]);
}

function detectPriorityFromText(text) {
  const t = safeText(text).toLowerCase();

  // emojis
  if (t.includes("🔥") || t.includes("🚨") || t.includes("❗") || t.includes("⚠")) {
    // se tem "urg" ou "crít" assume urgente
    if (t.includes("urg") || t.includes("crít") || t.includes("crit")) return "urgente";
    return "alta";
  }

  // palavras-chave
  if (/(urgente|cr[ií]tico|critico|cr[ií]tica|emerg[eê]ncia|emergencia|parou|travou|fora do ar)/.test(t)) {
    return "urgente";
  }
  if (/(prioridade\s*alta|alta\s*prioridade|alta|importante|hoje|agora)/.test(t)) {
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

function buildTitleFromMessage(text) {
  const t = safeText(text);
  if (!t) return "Solicitação via Telegram";
  // remove comandos como /p alta
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

// =========================================================
// Rate limit simples em memória (anti-spam básico)
// - 1 msg a cada 3s por userId (telegram from.id)
// =========================================================
const RL = new Map(); // key -> { lastMs }
function hitRateLimit(key, minIntervalMs) {
  const now = Date.now();
  const cur = RL.get(key) || { lastMs: 0 };
  if (now - cur.lastMs < minIntervalMs) return true;
  RL.set(key, { lastMs: now });
  return false;
}

// =========================================================
// Handler
// =========================================================
async function handleUpdate(tg, cfg, req, res) {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message || null;

    if (!msg) return res.json({ ok: true });

    const chatId = msg?.chat?.id;
    const fromId = msg?.from?.id;
    const text = safeText(msg?.text);

    if (!chatId) return res.json({ ok: true });

    // Secret token do webhook (se estiver usando)
    if (cfg.TELEGRAM_WEBHOOK_SECRET) {
      const secretHeader =
        req.headers["x-telegram-bot-api-secret-token"] ||
        req.headers["X-Telegram-Bot-Api-Secret-Token"];

      if (secretHeader && String(secretHeader) !== String(cfg.TELEGRAM_WEBHOOK_SECRET)) {
        return res.status(401).json({ ok: false });
      }
    }

    const lockOn = isAuthLockOn(cfg);
    const masterChatId = String(cfg.MASTER_CHAT_ID || "").trim(); // Wendell aqui
    const officeChatId = String(cfg.OFFICE_CHAT_ID || "").trim();

    const { usersCol, tasksCol, linkTokensCol } = collections();

    // HELP
    if (text === "/start" || text === "/help") {
      const help =
        "✅ VeroBot — Solicitações\n\n" +
        "Envie sua solicitação normalmente.\n\n" +
        "Prioridade (opcional):\n" +
        "• /p baixa\n" +
        "• /p media\n" +
        "• /p alta\n" +
        "• /p urgente\n\n" +
        "Exemplo:\n" +
        "/p urgente\n" +
        "Sistema travou e não imprime!";
      await sendText(tg, chatId, help);
      return res.json({ ok: true });
    }

    // Rate limit (evita flood)
    if (fromId && hitRateLimit(`u:${fromId}`, 3000)) {
      await sendText(tg, chatId, "⏳ Aguarde 3s e envie novamente.");
      return res.json({ ok: true });
    }

    // Se AUTH_LOCK ON, mantém restrito (somente vinculados)
    if (lockOn) {
      const linkedSnap = await usersCol.where("telegramChatId", "==", chatId).limit(1).get();
      const isLinked = !linkedSnap.empty;

      // mantém /link funcionando se você quiser (opcional)
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
          await sendText(tg, chatId, "❌ Token inválido. Gere outro no painel e tente novamente.");
          return res.json({ ok: true });
        }
        const tokenDoc = tokenSnap.data() || {};
        if (tokenDoc.consumedAt) {
          await sendText(tg, chatId, "⚠️ Esse token já foi usado. Gere outro no painel.");
          return res.json({ ok: true });
        }
        const uid = String(tokenDoc.uid || "").trim();
        if (!uid) {
          await sendText(tg, chatId, "❌ Token inválido (sem UID).");
          return res.json({ ok: true });
        }
        const userRef = usersCol.doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
          await sendText(tg, chatId, "❌ Usuário não encontrado no sistema.");
          return res.json({ ok: true });
        }

        await userRef.set(
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

        await sendText(tg, chatId, "✅ Telegram vinculado com sucesso!");
        return res.json({ ok: true });
      }

      if (!isLinked) {
        await sendText(
          tg,
          chatId,
          "🔒 Acesso restrito.\n\nFaça login no painel e vincule seu Telegram:\n/link SEU_TOKEN"
        );
        return res.json({ ok: true });
      }
      // vinculado — aqui você poderia tratar comandos internos
      await sendText(tg, chatId, "✅ Ok! Envie sua solicitação.");
      return res.json({ ok: true });
    }

    // ============================================
    // MODO PÚBLICO (AUTH_LOCK OFF): cria tarefa
    // ============================================
    const pr = pickPriority(text);
    const title = buildTitleFromMessage(text);
    const userLabel = fmtUserLabel(msg);
    const chatLabel = fmtChatLabel(msg);
    const badge = priorityBadge(pr);

    // 1) salvar no Firestore (pra aparecer no OfficePanel)
    let createdId = null;
    if (tasksCol) {
      try {
        const docRef = await tasksCol.add({
          title,
          message: text,
          description: text,

          priority: pr,           // baixa | media | alta | urgente
          status: "aberta",       // padrão
          createdAt: nowTS(),
          updatedAt: nowTS(),

          // útil pra UI não ficar "De: —"
          fromLabel: userLabel,
          fromChatId: chatId,
          fromUserId: fromId || null,

          source: "telegram_public",

          telegram: {
            fromId: fromId || null,
            chatId,
            userLabel,
            chatLabel,
            rawText: text,
          },

          deliveredTo: {
            masterChatId: masterChatId || null,
            officeChatId: officeChatId || null,
          },
        });

        createdId = docRef?.id || null;
      } catch (e) {
        console.error("[telegram_public] failed to create task:", e?.message || e);
      }
    }

    // 2) notificar MASTER + OFFICE
    const payloadHtml =
      `📩 <b>${badge}</b>\n` +
      `<b>Tarefa:</b> ${title}\n` +
      `<b>De:</b> ${userLabel}\n` +
      `<b>Chat:</b> ${chatLabel}\n\n` +
      `<b>Mensagem:</b>\n${text || "(sem texto)"}\n` +
      (createdId ? `\n<b>ID:</b> <code>${createdId}</code>\n` : "");

    if (masterChatId) {
      await sendText(tg, masterChatId, payloadHtml, { parse_mode: "HTML" });
    }
    if (officeChatId) {
      await sendText(tg, officeChatId, payloadHtml, { parse_mode: "HTML" });
    }

    // 3) responder pro usuário (confirmando + prioridade)
    const reply =
      `✅ Recebido! Já encaminhei sua solicitação.\n\n` +
      `📌 Prioridade: ${badge}\n` +
      (createdId ? `🧾 Protocolo: ${createdId}\n\n` : "\n") +
      `Se quiser mudar a prioridade, envie:\n` +
      `/p baixa | /p media | /p alta | /p urgente`;

    await sendText(tg, chatId, reply);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram][webhookHandler] error:", err);
    // sempre 200 para não ficar reenviando update
    return res.status(200).json({ ok: true });
  }
}

module.exports = { handleUpdate };
