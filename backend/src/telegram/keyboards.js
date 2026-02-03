// src/telegram/keyboards.js
function officeKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "🔴 Alta", callback_data: `prio:${taskId}:alta` },
        { text: "🟡 Média", callback_data: `prio:${taskId}:media` },
        { text: "🟢 Baixa", callback_data: `prio:${taskId}:baixa` },
      ],
      [{ text: "📨 Enviar ações pro Master", callback_data: `to_master:${taskId}` }],
    ],
  };
}

function masterKeyboard(taskId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Concluir", callback_data: `mstatus:${taskId}:feito` },
        { text: "⏳ Pendente", callback_data: `mstatus:${taskId}:pendente` },
      ],
      [{ text: "🚫 Deu ruim", callback_data: `mstatus:${taskId}:deu_ruim` }],
      [{ text: "📝 Pedir detalhes", callback_data: `mdetails:${taskId}` }],
      [{ text: "💬 Responder", callback_data: `mcomment:${taskId}` }],
    ],
  };
}

module.exports = { officeKeyboard, masterKeyboard };
