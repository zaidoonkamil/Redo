const axios = require("axios");

const WA_BASE_URL = process.env.WA_BASE_URL;
const WA_API_KEY  = process.env.WA_API_KEY;

async function sendWhatsAppText(toPhoneE164NoPlus, message) {
  if (!WA_BASE_URL) throw new Error("WA_BASE_URL missing");
  if (!WA_API_KEY) throw new Error("WA_API_KEY missing");

  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": WA_API_KEY,
  };

  const payload = {
    to: toPhoneE164NoPlus,
    message: message,
  };

  const { data } = await axios.post(`${WA_BASE_URL}/messages`, payload, { headers });
  return data;
}

module.exports = { sendWhatsAppText };
