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

function priorityBadge(p) {
  const pr = normalizePriority(p);
  if (pr === "urgente") return "🚨 URGENTE";
  if (pr === "alta") return "🔥 ALTA";
  if (pr === "baixa") return "🟢 BAIXA";
  return "🟡 MÉDIA";
}

function parsePriorityFromCommand(rawText) {
  // aceita:
  // /p alta
  // /prioridade urgente
  // /p urgente\nmensagem
  // /p alta mensagem...
  const t = safeText(rawText);
  if (!t) return { priority: "media", cleanText: "" };

  // multiline: primeira linha /p X
  const lines = t.split("\n");
  const first = safeText(lines[0]);

  const m1 = first.match(/^\/(?:p|prioridade)\s+(baixa|media|m[eé]dia|alta|urgente|critica|cr[ií]tica)\s*$/i);
  if (m1) {
    const pr = normalizePriority(m1[1]);
    const cleanText = safeText(lines.slice(1).join("\n"));
    return { priority: pr, cleanText };
  }

  // inline: /p alta mensagem...
  const m2 = t.match(/^\/(?:p|prioridade)\s+(baixa|media|m[eé]dia|alta|urgente|critica|cr[ií]tica)\s+([\s\S]+)$/i);
  if (m2) {
    const pr = normalizePriority(m2[1]);
    const cleanText = safeText(m2[2]);
    return { priority: pr, cleanText };
  }

  return { priority: null, cleanText: t };
}

function detectPriorityFromText(text) {
  const t = safeText(text).toLowerCase();
  if (!t) return "media";

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

function buildTitle(text) {
  const t = safeText(text);
  if (!t) return "Solicitação via Telegram";
  return t.replace(/\s+/g, " ").slice(0, 80);
}

// rate-limit simples
const RL = new Map();
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
    const rawText = safeText(msg?.text);

    if (!chatId) return res.json({ ok: true });

    // Secret do webhook (se usar)
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

    // help
    if (rawText === "/start" || rawText === "/help") {
      await sendText(
        tg,
        chatId,
        "✅ VeroBot\n\nEnvie sua solicitação.\n\nPrioridade:\n/p baixa\n/p media\n/p alta\n/p urgente\n\nEx:\n/p urgente\nSistema travou!"
      );
      return res.json({ ok: true });
    }

    // anti flood
    if (fromId && hitRateLimit(`u:${fromId}`, 2500)) {
      await sendText(tg, chatId, "⏳ Aguarde 2s e tente novamente.");
      return res.json({ ok: true });
    }

    // LOCK ON (mantém /link se precisar)
    if (lockOn) {
      const linkedSnap = await usersCol.where("telegramChatId", "==", chatId).limit(1).get();
      const isLinked = !linkedSnap.empty;

      const linkMatch = rawText.match(/^\/link(?:@[\w_]+)?\s+(\S+)\s*$/i);
      if (!isLinked && linkMatch && linkMatch[1]) {
        const tokenId = String(linkMatch[1]).trim();
        if (!linkTokensCol) {
          await sendText(tg, chatId, "❌ Vinculação indisponível.");
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
          { consumedAt: nowTS(), consumedByChatId: chatId, consumedByUserId: fromId || null },
          { merge: true }
        );

        await sendText(tg, chatId, "✅ Telegram vinculado!");
        return res.json({ ok: true });
      }

      if (!isLinked) {
        await sendText(tg, chatId, "🔒 Acesso restrito.\n\nVincule no painel:\n/link SEU_TOKEN");
        return res.json({ ok: true });
      }

      await sendText(tg, chatId, "✅ Ok! Envie sua solicitação.");
      return res.json({ ok: true });
    }

    // =====================================================
    // MODO PÚBLICO (LOCK OFF) — CRIA TASK + NOTIFICA
    // =====================================================
    const userLabel = fmtUserLabel(msg);

    // prioridade via /p ou detecção por texto
    const parsed = parsePriorityFromCommand(rawText);
    const pr = normalizePriority(parsed.priority || detectPriorityFromText(parsed.cleanText));
    const badge = priorityBadge(pr);

    // mensagem final que vai para o Office
    const finalText = safeText(parsed.cleanText) || safeText(rawText) || "(sem texto)";
    const title = buildTitle(finalText);

    // by/createdBy para preencher "De:"
    const by = {
      uid: `tg:${fromId || "unknown"}`,
      name: userLabel, // <- isso já preencheu seu "De: Wendell | id..."
      email: null,
      source: "telegram",
      telegramUserId: fromId || null,
      telegramChatId: chatId,
    };

    // SALVAR NO FIRESTORE com redundância máxima:
    // (a sua UI pode ler qualquer um desses)
    let createdId = null;

    if (tasksCol) {
      const docRef = await tasksCol.add({
        // campos "prováveis" que sua UI usa
        message: finalText,
        text: finalText,
        content: finalText,
        body: finalText,
        description: finalText,
        title,

        // autor (pra UI)
        by,
        createdBy: by,
        requester: by,
        from: by,
        fromLabel: userLabel,

        // status e prioridade
        status: "aberta",
        priority: pr,

        // compat com officeSignal
        officeSignal: null,
        officeComment: "",
        officeSignaledAt: null,

        // timestamps
        createdAt: nowTS(),
        updatedAt: nowTS(),

        // rastreio
        source: "telegram_public",
        telegram: {
          rawText: rawText,
          cleanText: finalText,
          priority: pr,
          fromId: fromId || null,
          chatId,
          userLabel,
        },
      });

      createdId = docRef?.id || null;
    }

    // NOTIFICAR TELEGRAM (MASTER + OFFICE)
    const payloadHtml =
      `📩 <b>${badge}</b>\n` +
      `<b>Tarefa:</b> ${title}\n` +
      `<b>De:</b> ${userLabel}\n\n` +
      `<b>Mensagem:</b>\n${finalText}\n` +
      (createdId ? `\n<b>ID:</b> <code>${createdId}</code>\n` : "");

    if (masterChatId) await sendText(tg, masterChatId, payloadHtml, { parse_mode: "HTML" });
    if (officeChatId) await sendText(tg, officeChatId, payloadHtml, { parse_mode: "HTML" });

    // responder usuário
    const reply =
      `✅ Recebido! Já enviei para o escritório.\n\n` +
      `📌 Prioridade: ${badge}\n` +
      (createdId ? `🧾 Protocolo: ${createdId}\n\n` : "\n") +
      `Para definir prioridade:\n/p baixa | /p media | /p alta | /p urgente`;

    await sendText(tg, chatId, reply);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram][webhookHandler] error:", err);
    return res.status(200).json({ ok: true });
  }
}

module.exports = { handleUpdate };
