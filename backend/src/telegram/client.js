// backend/src/telegram/client.js
/* eslint-disable */
const axios = require("axios");

function createTelegramClient(cfg) {
  if (!cfg?.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const api = axios.create({
    baseURL: `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}`,
    timeout: 20000,
  });

  // =========================================================
  // Helpers "amigáveis" (compat com watcher atual)
  // =========================================================
  api.sendMessage = async function sendMessage(chatId, text, opts = {}) {
    const payload = {
      chat_id: chatId,
      text,
      ...opts,
    };
    const r = await api.post("/sendMessage", payload);
    return r?.data?.result || r?.data || null;
  };

  api.editMessageText = async function editMessageText(chatId, messageId, text, opts = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...opts,
    };
    const r = await api.post("/editMessageText", payload);
    return r?.data?.result || r?.data || null;
  };

  api.answerCallbackQuery = async function answerCallbackQuery(callbackQueryId, opts = {}) {
    const payload = {
      callback_query_id: callbackQueryId,
      ...opts,
    };
    const r = await api.post("/answerCallbackQuery", payload);
    return r?.data?.result || r?.data || null;
  };

  return api;
}

module.exports = { createTelegramClient };