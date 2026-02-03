// src/services/awaiting.js
const { collections } = require("../firebase/collections");
const { getAdmin } = require("../firebase/admin");

function nowTS() {
  return getAdmin().firestore.Timestamp.now();
}

async function setAwaiting(userId, taskId) {
  const { awaitingCol } = collections();
  await awaitingCol.doc(String(userId)).set({ taskId, at: nowTS() });
}

async function popAwaiting(userId) {
  const { awaitingCol } = collections();
  const ref = awaitingCol.doc(String(userId));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  await ref.delete();
  return data;
}

async function setAwaitingMaster(userId, taskId) {
  const { awaitingMasterCol } = collections();
  await awaitingMasterCol.doc(String(userId)).set({ taskId, at: nowTS() });
}

async function popAwaitingMaster(userId) {
  const { awaitingMasterCol } = collections();
  const ref = awaitingMasterCol.doc(String(userId));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  await ref.delete();
  return data;
}

module.exports = { nowTS, setAwaiting, popAwaiting, setAwaitingMaster, popAwaitingMaster };
