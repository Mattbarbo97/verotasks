// src/firebase/admin.js
const admin = require("firebase-admin");

function initFirebase(cfg) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(cfg._SERVICE_ACCOUNT_JSON),
    });
  }
  return admin;
}

function getAdmin() {
  return admin;
}

module.exports = { initFirebase, getAdmin };
