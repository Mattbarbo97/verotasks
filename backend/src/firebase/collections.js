// backend/src/firebase/collections.js
const { getAdmin } = require("./admin");

function getDb() {
  // getAdmin() já chama initFirebaseAdmin() internamente
  return getAdmin().firestore();
}

function collections() {
  const db = getDb();

  return {
    db,

    // Core
    tasksCol: db.collection("tasks"),
    usersCol: db.collection("users"),

    // Tokens de vínculo do Telegram (/link TOKEN)
    linkTokensCol: db.collection("link_tokens"),

    // Idempotência / rastreio de updates do Telegram (evita duplicar tasks)
    telegramUpdatesCol: db.collection("telegram_updates"),

    // Fluxos "awaiting"
    awaitingCol: db.collection("awaiting_details"), // docId=userId
    awaitingMasterCol: db.collection("awaiting_master_comment"), // docId=userId
  };
}

module.exports = { collections };
