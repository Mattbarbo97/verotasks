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
  return tg.post("/sendMessage", {
    chat_id: chatId,
    text,
    ...opts,
  });
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

async function handleUpdate(tg, cfg, req, res) {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message || null;

    if (!msg) return res.json({ ok: true });

    const chatId = msg?.chat?.id;
    const fromId = msg?.from?.id;
    const text = safeText(msg?.text);

    if (!chatId) return res.json({ ok: true });

    // Webhook secret (se estiver usando)
    if (cfg.TELEGRAM_WEBHOOK_SECRET) {
      const secretHeader =
        req.headers["x-telegram-bot-api-secret-token"] ||
        req.headers["X-Telegram-Bot-Api-Secret-Token"];
      if (secretHeader && String(secretHeader) !== String(cfg.TELEGRAM_WEBHOOK_SECRET)) {
        return res.status(401).json({ ok: false });
      }
    }

    const { usersCol, tasksCol, linkTokensCol } = collections();

    const lockOn = isAuthLockOn(cfg);
    const masterChatId = String(cfg.MASTER_CHAT_ID || "").trim();

    // ====== HELP ======
    if (text === "/start" || text === "/help") {
      if (lockOn) {
        await sendText(
          tg,
          chatId,
          "🔒 Acesso restrito.\n\nFaça login no painel e vincule seu Telegram:\n/link SEU_TOKEN"
        );
      } else {
        await sendText(
          tg,
          chatId,
          "✅ Bot público habilitado.\n\nEnvie sua solicitação aqui que eu encaminho ao responsável."
        );
      }
      return res.json({ ok: true });
    }

    // ====== LINK (se quiser manter compatível) ======
    // Se lock ON, exige token; se lock OFF, você pode ignorar /link (ou manter).
    const linkMatch = text.match(/^\/link(?:@[\w_]+)?\s+(\S+)\s*$/i);
    if (linkMatch && linkMatch[1]) {
      const tokenId = String(linkMatch[1]).trim();

      if (!lockOn) {
        // em modo público, não precisamos de link.
        await sendText(
          tg,
          chatId,
          "✅ Modo público: você não precisa vincular.\n\nEnvie sua solicitação normalmente."
        );
        return res.json({ ok: true });
      }

      // lock ON: valida token real (se existir linkTokensCol)
      if (!linkTokensCol) {
        await sendText(tg, chatId, "❌ Vinculação indisponível (linkTokensCol não configurado).");
        return res.json({ ok: true });
      }

      const tokenRef = linkTokensCol.doc(tokenId);
      const tokenSnap = await tokenRef.get();

      if (!tokenSnap.exists) {
        await sendText(
          tg,
          chatId,
          "❌ Token inválido ou não encontrado.\n\nVolte ao painel e gere um novo token e envie:\n/link SEU_TOKEN"
        );
        return res.json({ ok: true });
      }

      const tokenDoc = tokenSnap.data() || {};
      const expiresAt = tokenDoc.expiresAt?.toDate ? tokenDoc.expiresAt.toDate() : null;

      if (expiresAt && expiresAt.getTime() < Date.now()) {
        await sendText(tg, chatId, "⏳ Token expirado. Gere um novo no painel e envie /link SEU_TOKEN.");
        return res.json({ ok: true });
      }

      if (tokenDoc.consumedAt) {
        await sendText(tg, chatId, "⚠️ Esse token já foi usado. Gere um novo no painel.");
        return res.json({ ok: true });
      }

      const uid = String(tokenDoc.uid || "").trim();
      if (!uid) {
        await sendText(tg, chatId, "❌ Token inválido (sem UID). Gere outro token no painel.");
        return res.json({ ok: true });
      }

      const userRef = usersCol.doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        await sendText(tg, chatId, "❌ Usuário não encontrado no sistema. Peça para o admin criar/ativar.");
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

    // ====== Se LOCK ON: exige vínculo ======
    if (lockOn) {
      const linkedSnap = await usersCol.where("telegramChatId", "==", chatId).limit(1).get();
      const isLinked = !linkedSnap.empty;

      if (!isLinked) {
        await sendText(
          tg,
          chatId,
          "🔒 Acesso restrito.\n\nFaça login no painel e vincule seu Telegram:\n/link SEU_TOKEN"
        );
        return res.json({ ok: true });
      }

      // vinculado: responde OK (ou continue seu fluxo normal)
      await sendText(tg, chatId, "✅ Ok! Estou online.");
      return res.json({ ok: true });
    }

    // ====== MODO PÚBLICO (AUTH_LOCK OFF): aceita de qualquer um ======
    const userLabel = fmtUserLabel(msg);
    const chatLabel = fmtChatLabel(msg);

    // 1) encaminha pro master
    if (masterChatId) {
      const forwarded =
        `📩 <b>Solicitação (PÚBLICO)</b>\n` +
        `<b>De:</b> ${userLabel}\n` +
        `<b>Chat:</b> ${chatLabel}\n\n` +
        `<b>Mensagem:</b>\n${text || "(sem texto)"}\n\n` +
        `<i>Responda manualmente a pessoa no Telegram se precisar.</i>`;

      // usa HTML pra ficar bonito
      await sendText(tg, masterChatId, forwarded, { parse_mode: "HTML" });
    }

    // 2) opcional: cria task no Firestore (se tasksCol existir)
    if (tasksCol) {
      try {
        await tasksCol.add({
          title: (text || "").slice(0, 120) || "Solicitação via Telegram",
          description: text || "",
          status: "aberta",
          priority: "normal",
          createdAt: nowTS(),
          updatedAt: nowTS(),
          source: "telegram_public",
          telegram: {
            fromId: fromId || null,
            chatId,
            userLabel,
            chatLabel,
          },
        });
      } catch (e) {
        // não quebra o bot
        console.error("[telegram_public] failed to create task:", e?.message || e);
      }
    }

    // 3) confirma pro usuário
    await sendText(
      tg,
      chatId,
      "✅ Recebido! Já encaminhei sua solicitação.\n\nSe precisar, envie mais detalhes aqui."
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram][webhookHandler] error:", err);
    return res.status(200).json({ ok: true });
  }
}

module.exports = { handleUpdate };
