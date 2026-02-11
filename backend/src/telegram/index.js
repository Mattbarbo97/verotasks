const client = require("./client");
const webhookHandler = require("./webhookHandler");

module.exports = {
  client,
  ...webhookHandler,
};
