// src/firebase/collections.js
const { getAdmin } = require("./admin");

function getDb() {
  return getAdmin().firestore();
}

function collections() {
  const db = getDb();
  return {
    db,
    tasksCol: db.collection("tasks"),
    usersCol: db.collection("users"),
    linkTokensCol: db.collection("link_tokens"),
    awaitingCol: db.collection("awaiting_details"), // docId=userId
    awaitingMasterCol: db.collection("awaiting_master_comment"), // docId=userId
  };
}

module.exports = { collections };
