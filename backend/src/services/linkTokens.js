// src/services/linkTokens.js
const { collections } = require("../firebase/collections");
const { nowTS } = require("./awaiting");
const { getAdmin } = require("../firebase/admin");

function makeLinkToken(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function addMinutes(ts, minutes) {
  const ms = ts?.toMillis ? ts.toMillis() : Date.now();
  return getAdmin().firestore.Timestamp.fromMillis(ms + minutes * 60 * 1000);
}

async function createUniqueLinkTokenDoc({ uid, email, ttlMin = 10 }) {
  const { linkTokensCol } = collections();
  const now = nowTS();
  const expiresAt = addMinutes(now, ttlMin);

  for (let i = 0; i < 10; i++) {
    const token = makeLinkToken(6);
    const ref = linkTokensCol.doc(token);
    const exists = await ref.get();
    if (exists.exists) continue;

    await ref.set({
      token,
      uid: String(uid),
      email: String(email).toLowerCase(),
      createdAt: now,
      expiresAt,
    });

    return { token, expiresAt, ttlMin };
  }

  throw new Error("could_not_generate_unique_token");
}

module.exports = { createUniqueLinkTokenDoc };
