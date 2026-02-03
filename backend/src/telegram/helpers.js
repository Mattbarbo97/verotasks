// src/telegram/helpers.js
function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncateText(text, max = 3900) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 40) + "\n\n…(mensagem truncada)…";
}

function telegramErrorInfo(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const desc = data?.description || data?.error || "";
  const code = data?.error_code;
  return {
    status: status || null,
    error_code: code || null,
    description: desc || safeStr(e?.message || e),
    data: data || null,
  };
}

function userLabel(from = {}) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || from.username || String(from.id || "usuario");
}

module.exports = {
  safeStr,
  escapeHtml,
  truncateText,
  telegramErrorInfo,
  userLabel,
};
