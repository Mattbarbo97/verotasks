// src/services/tasks.js
const { collections } = require("../firebase/collections");
const { getAdmin } = require("../firebase/admin");

const { nowTS, setAwaitingMaster } = require("./awaiting");
const { userLabel, escapeHtml } = require("../telegram/helpers");

const { isClosedStatus, badgeStatus, badgePriority, officeSignalLabel, taskCardText } = require("../telegram/text");
const { officeKeyboard, masterKeyboard } = require("../telegram/keyboards");

function FieldValue() {
  return getAdmin().firestore.FieldValue;
}

async function refreshOfficeCard(tgApi, taskId) {
  const { tasksCol } = collections();
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data();
  if (!t.office?.chatId || !t.office?.messageId) return;

  const closing = isClosedStatus(t.status);
  const kb = closing ? { inline_keyboard: [] } : officeKeyboard(taskId);

  await tgApi.editMessage(t.office.chatId, t.office.messageId, taskCardText(taskId, t), {
    reply_markup: kb,
  });
}

async function notifyMasterAboutOfficeSignal(tgApi, cfg, { taskId, t, state, comment, byEmail }) {
  const createdByName = t?.createdBy?.name ? String(t.createdBy.name) : "—";
  const prio = t?.priority ? String(t.priority) : "media";
  const msg = t?.source?.text ? String(t.source.text) : "—";

  const text =
    `📨 <b>Escritório pediu ação</b>\n` +
    `• tarefa: <code>${taskId}</code>\n` +
    `• de: <b>${escapeHtml(createdByName)}</b>\n` +
    `• prioridade: ${badgePriority(prio)}\n` +
    `• pedido: ${officeSignalLabel(state)}\n` +
    (byEmail ? `• por: <b>${escapeHtml(byEmail)}</b>\n` : "") +
    (comment ? `\n<b>Comentário:</b>\n${escapeHtml(comment)}\n` : "") +
    `\n<b>Mensagem original:</b>\n${escapeHtml(msg)}`;

  await tgApi.sendMessage(cfg.MASTER_CHAT_ID, text, { reply_markup: masterKeyboard(taskId) });
}

async function finalizeWithDetails(tgApi, taskId, from, detailsText) {
  const { tasksCol } = collections();
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const operatorName = userLabel(from);

  await ref.update({
    details: String(detailsText || "").slice(0, 4000),
    status: "feito_detalhes",
    closedAt: nowTS(),
    closedBy: { userId: from.id, name: operatorName },
    audit: FieldValue().arrayUnion({
      at: nowTS(),
      by: { userId: from.id, name: operatorName },
      action: "details",
      meta: { len: String(detailsText || "").length },
    }),
  });

  const updated = (await ref.get()).data();

  // atualiza card do escritório (remove teclado)
  if (updated.office?.chatId && updated.office?.messageId) {
    await tgApi.editMessage(updated.office.chatId, updated.office.messageId, taskCardText(taskId, updated), {
      reply_markup: { inline_keyboard: [] },
    });
  }

  // avisa solicitante
  const createdChatId = updated.createdBy?.chatId;
  if (createdChatId) {
    await tgApi.sendMessage(
      createdChatId,
      `📣 Sua tarefa <code>${taskId}</code> foi concluída com detalhes.\n` + `📌 Status: ${badgeStatus(updated.status)}`
    );
  }
}

async function saveMasterComment(tgApi, taskId, from, commentText) {
  const { tasksCol } = collections();
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const masterName = userLabel(from);
  const t = snap.data();

  await ref.update({
    masterComment: String(commentText || "").slice(0, 2000),
    masterCommentAt: nowTS(),
    audit: FieldValue().arrayUnion({
      at: nowTS(),
      by: { userId: from.id, name: masterName },
      action: "master_comment",
      meta: { len: String(commentText || "").length },
    }),
  });

  // avisa escritório
  if (t.office?.chatId) {
    await tgApi.sendMessage(
      t.office.chatId,
      `💬 <b>Master respondeu</b>\n` + `🧾 Tarefa <code>${taskId}</code>\n\n` + `${escapeHtml(String(commentText || ""))}`
    );
  }

  await refreshOfficeCard(tgApi, taskId);
}

async function masterSetStatus(tgApi, cfg, { taskId, cbFrom, status }) {
  const { tasksCol } = collections();
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data() || {};
  const operatorName = userLabel(cbFrom);
  const closing = status === "feito" || status === "deu_ruim";

  await ref.update({
    status,
    closedAt: closing ? nowTS() : null,
    closedBy: { userId: cbFrom.id, name: operatorName, via: "master" },
    audit: FieldValue().arrayUnion({
      at: nowTS(),
      by: { userId: cbFrom.id, name: operatorName },
      action: "master_status",
      meta: { status },
    }),
  });

  await refreshOfficeCard(tgApi, taskId);

  const updated = (await ref.get()).data();

  // avisa solicitante
  const createdChatId = updated.createdBy?.chatId;
  if (createdChatId) {
    await tgApi.sendMessage(
      createdChatId,
      `📣 Sua tarefa <code>${taskId}</code> foi atualizada pelo Master:\n` +
        `📌 Status: ${badgeStatus(updated.status)}\n` +
        `⚡ Prioridade: ${badgePriority(updated.priority)}`
    );
  }

  // avisa escritório
  const officeChatId = t.office?.chatId;
  if (officeChatId) {
    await tgApi.sendMessage(
      officeChatId,
      `📬 <b>Master decidiu</b>\n` + `🧾 Tarefa <code>${taskId}</code>\n` + `📌 Status: ${badgeStatus(status)}`
    );
  }
}

async function officeSetPriority(tgApi, { taskId, cbFrom, priority }) {
  const { tasksCol } = collections();
  const ref = tasksCol.doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const t = snap.data() || {};
  const operatorName = userLabel(cbFrom);

  await ref.update({
    priority,
    audit: FieldValue().arrayUnion({
      at: nowTS(),
      by: { userId: cbFrom.id, name: operatorName },
      action: "priority",
      meta: { priority },
    }),
  });

  const updated = (await ref.get()).data();
  const officeChatId = t.office?.chatId;
  const officeMessageId = t.office?.messageId;

  if (officeChatId && officeMessageId) {
    await tgApi.editMessage(officeChatId, officeMessageId, taskCardText(taskId, updated), {
      reply_markup: isClosedStatus(updated.status) ? { inline_keyboard: [] } : officeKeyboard(taskId),
    });
  }
}

async function masterAskComment(tgApi, cfg, { taskId, cbFrom }) {
  await setAwaitingMaster(cbFrom.id, taskId);

  await tgApi.sendMessage(
    cfg.MASTER_CHAT_ID,
    `💬 <b>Responder tarefa</b>\n` + `🧾 Tarefa: <code>${taskId}</code>\n` + `Envie UMA mensagem com sua resposta.`
  );
}

/* =========================================================
   ✅ NOVO: Atribuição (Assign) + Notificação ao colaborador
   - Usa vínculo já existente no users:
     users/{uid}.telegramChatId
   ========================================================= */

async function notifyAssigneeTelegram(tgApi, taskId, taskDoc, assigneeUserDoc) {
  const chatId = assigneeUserDoc?.telegramChatId ? String(assigneeUserDoc.telegramChatId) : "";
  if (!chatId) return;

  const title = taskDoc?.source?.text ? String(taskDoc.source.text) : "Nova tarefa";
  const prio = taskDoc?.priority ? String(taskDoc.priority) : "media";
  const createdBy = taskDoc?.createdBy?.name ? String(taskDoc.createdBy.name) : "—";

  const text =
    `📌 <b>Tarefa atribuída a você</b>\n` +
    `• id: <code>${taskId}</code>\n` +
    `• prioridade: ${badgePriority(prio)}\n` +
    `• de: <b>${escapeHtml(createdBy)}</b>\n\n` +
    `<b>Mensagem:</b>\n${escapeHtml(title)}`;

  await tgApi.sendMessage(chatId, text);
}

async function masterAssignTask(tgApi, cfg, { taskId, cbFrom, assigneeUid }) {
  const { tasksCol, usersCol } = collections();

  const uid = String(assigneeUid || "").trim();
  if (!uid) {
    await tgApi.sendMessage(cfg.MASTER_CHAT_ID, "🚫 UID inválido para atribuição.");
    return;
  }

  const taskRef = tasksCol.doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    await tgApi.sendMessage(cfg.MASTER_CHAT_ID, "🚫 Tarefa não encontrada.");
    return;
  }

  const userRef = usersCol.doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await tgApi.sendMessage(cfg.MASTER_CHAT_ID, "🚫 Usuário não encontrado.");
    return;
  }

  const userDoc = userSnap.data() || {};
  // Mantém coerência com seu allow-list (admin/office)
  const status = String(userDoc.status || "active");
  const role = String(userDoc.role || "office");
  if (status !== "active" || !["admin", "office"].includes(role)) {
    await tgApi.sendMessage(cfg.MASTER_CHAT_ID, "🚫 Usuário existe, mas está inativo ou sem permissão.");
    return;
  }

  const operatorName = userLabel(cbFrom);
  const email = userDoc.email ? String(userDoc.email).toLowerCase() : "";
  const name = userDoc.name ? String(userDoc.name) : email || uid;

  await taskRef.update({
    assignedTo: { uid, email, name },
    assignedAt: nowTS(),
    assignedBy: { userId: cbFrom.id, name: operatorName, via: "master" },
    audit: FieldValue().arrayUnion({
      at: nowTS(),
      by: { userId: cbFrom.id, name: operatorName },
      action: "assign",
      meta: { uid, email, name },
    }),
  });

  const updatedTask = (await taskRef.get()).data() || {};

  // Atualiza card do escritório (pra aparecer assignedTo no texto caso seu card exiba)
  await refreshOfficeCard(tgApi, taskId);

  // Notifica o colaborador (se ele estiver vinculado via /link)
  await notifyAssigneeTelegram(tgApi, taskId, updatedTask, userDoc);

  // Avisa master
  await tgApi.sendMessage(
    cfg.MASTER_CHAT_ID,
    `✅ Atribuído.\n🧾 Tarefa <code>${taskId}</code>\n👤 Para: <b>${escapeHtml(name)}</b>` + (email ? ` (<code>${escapeHtml(email)}</code>)` : "")
  );

  // Avisa escritório (opcional, mas útil)
  if (updatedTask.office?.chatId) {
    await tgApi.sendMessage(
      updatedTask.office.chatId,
      `📍 <b>Tarefa atribuída</b>\n🧾 <code>${taskId}</code>\n👤 Para: <b>${escapeHtml(name)}</b>`
    );
  }

  // Avisa solicitante (opcional)
  const createdChatId = updatedTask.createdBy?.chatId;
  if (createdChatId) {
    await tgApi.sendMessage(
      createdChatId,
      `📍 Sua tarefa <code>${taskId}</code> foi atribuída para: <b>${escapeHtml(name)}</b>`
    );
  }
}

module.exports = {
  refreshOfficeCard,
  notifyMasterAboutOfficeSignal,
  finalizeWithDetails,
  saveMasterComment,
  masterSetStatus,
  officeSetPriority,
  masterAskComment,

  // ✅ novo
  masterAssignTask,
};
