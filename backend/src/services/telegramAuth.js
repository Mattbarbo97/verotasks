// src/services/telegramAuth.js
const { collections } = require("../firebase/collections");

function isPrivilegedChat(cfg, chatId) {
  if (String(chatId || "") === String(cfg.MASTER_CHAT_ID)) return true;
  if (cfg.OFFICE_CHAT_ID && String(chatId || "") === String(cfg.OFFICE_CHAT_ID)) return true;
  return false;
}

function isUserAllowed(userDoc) {
  if (!userDoc) return false;
  const status = String(userDoc.status || "active");
  const role = String(userDoc.role || "office");
  if (status !== "active") return false;
  if (!["admin", "office"].includes(role)) return false;
  return true;
}

async function findUserByTelegramUserId(telegramUserId) {
  const { usersCol } = collections();
  const uid = String(telegramUserId || "");
  if (!uid) return null;

  const snap = await usersCol.where("telegramUserId", "==", uid).limit(1).get();
  if (snap.empty) return null;

  const doc0 = snap.docs[0];
  return { id: doc0.id, ...doc0.data() };
}

/**
 * Precisa estar vinculado e no mesmo chat vinculado (fora chats privilegiados)
 */
async function ensureTelegramLinkedOrThrow(cfg, message) {
  const chatId = message?.chat?.id;
  const from = message?.from || {};
  const telegramUserId = String(from.id || "");
  const telegramChatId = String(chatId || "");

  if (!telegramUserId) return { ok: false, reason: "missing_from" };
  if (isPrivilegedChat(cfg, chatId)) return { ok: true, bypass: true };

  const user = await findUserByTelegramUserId(telegramUserId);
  if (!user) return { ok: false, reason: "not_linked" };
  if (!isUserAllowed(user)) return { ok: false, reason: "not_allowed" };

  const linkedChat = String(user.telegramChatId || "");
  if (!linkedChat || linkedChat !== telegramChatId) {
    return { ok: false, reason: "chat_mismatch" };
  }

  return { ok: true, user };
}

module.exports = { isUserAllowed, ensureTelegramLinkedOrThrow };
