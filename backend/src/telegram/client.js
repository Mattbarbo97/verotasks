// src/telegram/client.js
const axios = require("axios");

function createTelegramClient(cfg) {
  return axios.create({
    baseURL: `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}`,
    timeout: 20000,
  });
}

module.exports = { createTelegramClient };
