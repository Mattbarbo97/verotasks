const admin = require("./admin");
const collections = require("./collections");

function initFirebase() {
  // força inicialização do admin (se o admin.js tiver lazy init)
  // se o admin.js já inicializa no require, isso não faz nada e tá ok
  if (typeof admin.getAdmin === "function") admin.getAdmin();
}

module.exports = {
  admin,
  collections,
  initFirebase,
};
