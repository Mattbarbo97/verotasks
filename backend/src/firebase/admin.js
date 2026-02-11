// src/firebase/admin.js
const admin = require("firebase-admin");

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("missing_FIREBASE_SERVICE_ACCOUNT");

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error("invalid_FIREBASE_SERVICE_ACCOUNT_json");
  }

  // Render/ENV normalmente vem com \n escapado
  if (json.private_key && typeof json.private_key === "string") {
    json.private_key = json.private_key.replace(/\\n/g, "\n");
  }

  return json;
}

/**
 * ✅ Inicializa Firebase Admin uma única vez (idempotente)
 * - lê FIREBASE_SERVICE_ACCOUNT do ENV
 */
function initFirebaseAdmin() {
  if (admin.apps && admin.apps.length) return admin;

  const serviceAccount = parseServiceAccountFromEnv();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

/**
 * ✅ Sempre retorna o admin inicializado (seguro)
 */
function getAdmin() {
  initFirebaseAdmin();
  return admin;
}

module.exports = { initFirebaseAdmin, getAdmin };
