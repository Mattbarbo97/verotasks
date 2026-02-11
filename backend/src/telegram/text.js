// src/telegram/text.js
const { escapeHtml, safeStr } = require("./helpers");

function isClosedStatus(status) {
  return ["feito", "feito_detalhes", "deu_ruim"].includes(String(status || ""));
}

function inferPriority(text = "") {
  const t = String(text || "").toLowerCase();
  const high = ["urgente", "agora", "hoje", "parou", "quebrou", "cliente", "erro", "nao funciona", "não funciona"];
  const low = ["quando der", "depois", "amanha", "amanhã", "sem pressa"];
  if (high.some((k) => t.includes(k))) return "alta";
  if (low.some((k) => t.includes(k))) return "baixa";
  return "media";
}

function badgePriority(p) {
  if (p === "alta") return "🔴 <b>ALTA</b>";
  if (p === "baixa") return "🟢 <b>BAIXA</b>";
  return "🟡 <b>MÉDIA</b>";
}

function badgeStatus(s) {
  const map = {
    aberta: "🆕 <b>ABERTA</b>",
    pendente: "⏳ <b>PENDENTE</b>",
    feito: "✅ <b>FEITO</b>",
    feito_detalhes: "📝 <b>FEITO (COM DETALHES)</b>",
    deu_ruim: "🚫 <b>DEU RUIM</b>",
  };
  return map[s] || `<b>${escapeHtml(s)}</b>`;
}

function officeSignalLabel(state) {
  const s = String(state || "");
  const map = {
    em_andamento: "🛠️ <b>EM ANDAMENTO</b>",
    preciso_ajuda: "🆘 <b>PRECISO DE AJUDA</b>",
    apresentou_problemas: "🚫 <b>APRESENTOU PROBLEMAS</b>",
    tarefa_executada: "✅ <b>TAREFA EXECUTADA</b>",
    comentario: "💬 <b>COMENTÁRIO</b>",
  };
  return map[s] || `<b>${escapeHtml(s || "—")}</b>`;
}

function taskCardText(taskId, t) {
  const createdAt = t.createdAt?.toDate ? t.createdAt.toDate() : new Date();
  const createdAtStr = createdAt.toLocaleString("pt-BR");
  const msg = t.source?.text || "—";

  // ✅ NOVO: bloco de atribuição
  let assignedBlock = "";
  if (t.assignedTo && typeof t.assignedTo === "object") {
    const name = safeStr(t.assignedTo.name || "");
    const email = safeStr(t.assignedTo.email || "");
    const uid = safeStr(t.assignedTo.uid || "");

    const when = t.assignedAt?.toDate ? t.assignedAt.toDate().toLocaleString("pt-BR") : "";
    const who = name || email || uid || "—";

    assignedBlock =
      `\n\n<b>Atribuição:</b>\n` +
      `👤 <b>Para:</b> ${escapeHtml(who)}` +
      (email && email !== who ? `\n✉️ <b>Email:</b> ${escapeHtml(email)}` : "") +
      (uid && uid !== who ? `\n🆔 <b>UID:</b> <code>${escapeHtml(uid)}</code>` : "") +
      (when ? `\n🕒 <b>Em:</b> ${escapeHtml(when)}` : "");
  }

  let detailsBlock = "";
  if (t.status === "feito_detalhes" && t.details) {
    detailsBlock = `\n\n<b>Detalhes:</b>\n${escapeHtml(t.details)}`;
  }

  let officeBlock = "";
  if (t.officeSignal && typeof t.officeSignal === "object" && t.officeSignal.state) {
    const when = t.officeSignal.updatedAt?.toDate
      ? t.officeSignal.updatedAt.toDate().toLocaleString("pt-BR")
      : "—";
    const comment = safeStr(t.officeSignal.comment || "");
    const by = t.officeSignal.updatedBy?.email ? safeStr(t.officeSignal.updatedBy.email) : "";

    officeBlock =
      `\n\n<b>Escritório:</b> ${officeSignalLabel(t.officeSignal.state)}\n` +
      `<b>Em:</b> ${escapeHtml(when)}` +
      (by ? `\n<b>Por:</b> ${escapeHtml(by)}` : "") +
      (comment ? `\n<b>Comentário:</b>\n${escapeHtml(comment)}` : "");
  }

  let masterBlock = "";
  if (t.masterComment) {
    const when = t.masterCommentAt?.toDate
      ? t.masterCommentAt.toDate().toLocaleString("pt-BR")
      : "—";
    masterBlock = `\n\n<b>Master:</b>\n${escapeHtml(t.masterComment)}\n<b>Em:</b> ${escapeHtml(when)}`;
  }

  return (
    `🧾 <b>Tarefa</b> #<code>${escapeHtml(taskId)}</code>\n` +
    `👤 <b>De:</b> ${escapeHtml(t.createdBy?.name || "—")}\n` +
    `🕒 <b>Em:</b> ${escapeHtml(createdAtStr)}\n` +
    `⚡ <b>Prioridade:</b> ${badgePriority(t.priority)}\n` +
    `📌 <b>Status:</b> ${badgeStatus(t.status)}\n\n` +
    `<b>Mensagem:</b>\n${escapeHtml(msg)}` +
    assignedBlock +
    detailsBlock +
    officeBlock +
    masterBlock
  );
}

module.exports = {
  isClosedStatus,
  inferPriority,
  badgePriority,
  badgeStatus,
  officeSignalLabel,
  taskCardText,
};
