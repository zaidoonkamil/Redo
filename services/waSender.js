const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.join(__dirname, "..", ".wwebjs_auth");
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "rido";
const AUTO_INIT = process.env.WHATSAPP_AUTO_INIT === "true";
const RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 15000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.WHATSAPP_MAX_RECONNECT_DELAY_MS || 120000);

let client = null;
let initializingPromise = null;
let latestQrText = null;
let latestQrImage = null;
let latestError = null;
let connectionStatus = "idle";
let authenticated = false;
let connectedNumber = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualLogout = false;

function resetRuntimeState() {
  latestQrText = null;
  latestQrImage = null;
  connectedNumber = null;
  authenticated = false;
}

function dropClientReference(reason = "client_reset") {
  latestError = reason;
  connectionStatus = "disconnected";
  client = null;
  initializingPromise = null;
  resetRuntimeState();
}

function isRecoverableSessionError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return (
    message.includes("detached frame") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("target closed") ||
    message.includes("session closed") ||
    message.includes("protocol error")
  );
}

async function destroyClientSilently(instance) {
  if (!instance) return;

  try {
    await instance.destroy();
  } catch (_) {
  }
}

async function recoverClientFromRuntimeError(error) {
  const failingClient = client;
  clearReconnectTimer();
  dropClientReference(error?.message || "recoverable_runtime_error");
  await destroyClientSilently(failingClient);
  return initWhatsAppClient();
}

function ensureSessionPath() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function getReconnectDelay() {
  const delay = RECONNECT_DELAY_MS * Math.max(1, reconnectAttempts);
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

function scheduleReconnect(reason = "unknown") {
  if (!AUTO_INIT || manualLogout || initializingPromise || client) {
    return;
  }

  clearReconnectTimer();
  reconnectAttempts += 1;
  const delay = getReconnectDelay();
  connectionStatus = "reconnecting";
  latestError = `Reconnecting after disconnect: ${reason}`;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await initWhatsAppClient();
    } catch (error) {
      latestError = error.message || String(error);
      scheduleReconnect(latestError);
    }
  }, delay);
}

function normalizeWhatsAppPhone(phone = "") {
  let value = String(phone).trim();

  if (!value) {
    throw new Error("Phone number is required");
  }

  value = value.replace(/[^\d+]/g, "");

  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("00")) value = value.slice(2);
  if (value.startsWith("0")) value = `964${value.slice(1)}`;

  if (!/^\d{8,15}$/.test(value)) {
    throw new Error("Phone number format is invalid");
  }

  return value;
}

function getStatus() {
  return {
    status: connectionStatus,
    authenticated,
    hasQr: Boolean(latestQrImage),
    connectedNumber,
    lastError: latestError,
  };
}

async function buildQrImage(qrText) {
  latestQrText = qrText;
  latestQrImage = await qrcode.toDataURL(qrText);
}

function bindClientEvents(instance) {
  instance.on("qr", async (qrText) => {
    clearReconnectTimer();
    connectionStatus = "qr_ready";
    latestError = null;
    connectedNumber = null;
    authenticated = false;

    try {
      await buildQrImage(qrText);
    } catch (error) {
      latestError = `QR generation failed: ${error.message}`;
    }
  });

  instance.on("authenticated", () => {
    clearReconnectTimer();
    reconnectAttempts = 0;
    authenticated = true;
    latestError = null;
    connectionStatus = "authenticated";
  });

  instance.on("ready", async () => {
    clearReconnectTimer();
    reconnectAttempts = 0;
    connectionStatus = "ready";
    latestQrText = null;
    latestQrImage = null;
    latestError = null;

    try {
      const wid = instance.info?.wid?._serialized || "";
      connectedNumber = wid.replace("@c.us", "") || null;
    } catch (_) {
      connectedNumber = null;
    }
  });

  instance.on("auth_failure", (message) => {
    clearReconnectTimer();
    authenticated = false;
    connectionStatus = "auth_failure";
    latestError = message || "Authentication failed";
  });

  instance.on("disconnected", (reason) => {
    dropClientReference(reason || "Client disconnected");

    if (!manualLogout) {
      scheduleReconnect(reason || "Client disconnected");
    }
  });
}

async function initWhatsAppClient() {
  if (client) {
    return getStatus();
  }

  if (initializingPromise) {
    await initializingPromise;
    return getStatus();
  }

  connectionStatus = "initializing";
  latestError = null;
  manualLogout = false;
  clearReconnectTimer();
  ensureSessionPath();

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: CLIENT_ID,
      dataPath: SESSION_PATH,
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  bindClientEvents(client);

  initializingPromise = client.initialize()
    .catch((error) => {
      latestError = error.message;
      connectionStatus = "failed";
      client = null;
      scheduleReconnect(error.message);
      throw error;
    })
    .finally(() => {
      initializingPromise = null;
    });

  await initializingPromise;
  return getStatus();
}

function ensureClientReady() {
  if (!client || connectionStatus !== "ready") {
    throw new Error("WhatsApp client is not ready. Scan QR and wait until status becomes ready.");
  }
}

async function getQrCode() {
  return {
    status: connectionStatus,
    qrText: latestQrText,
    qrImage: latestQrImage,
  };
}

async function logoutWhatsApp() {
  manualLogout = true;
  clearReconnectTimer();

  if (!client) {
    connectionStatus = "idle";
    resetRuntimeState();
    return { success: true, status: connectionStatus };
  }

  try {
    await client.logout();
  } catch (_) {
  }

  try {
    await client.destroy();
  } catch (_) {
  }

  client = null;
  initializingPromise = null;
  latestError = null;
  connectionStatus = "idle";
  resetRuntimeState();

  return { success: true, status: connectionStatus };
}

function startWhatsAppAutoInit() {
  if (!AUTO_INIT) {
    return;
  }

  scheduleReconnect("server_boot");
}

async function resolveChatId(phone) {
  ensureClientReady();

  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const numberId = await client.getNumberId(normalizedPhone);

  if (!numberId?._serialized) {
    throw new Error("This number does not appear to have WhatsApp");
  }

  return {
    phone: normalizedPhone,
    chatId: numberId._serialized,
  };
}

async function sendWhatsAppText(phone, message) {
  if (!message || !String(message).trim()) {
    throw new Error("Message is required");
  }

  try {
    const { phone: normalizedPhone, chatId } = await resolveChatId(phone);
    const sentMessage = await client.sendMessage(chatId, String(message).trim());

    return {
      to: normalizedPhone,
      messageId: sentMessage?.id?._serialized || null,
      timestamp: sentMessage?.timestamp || null,
      status: "sent",
    };
  } catch (error) {
    if (!isRecoverableSessionError(error)) {
      throw error;
    }

    latestError = `Recovered from runtime error: ${error.message || error}`;
    await recoverClientFromRuntimeError(error);

    const { phone: normalizedPhone, chatId } = await resolveChatId(phone);
    const sentMessage = await client.sendMessage(chatId, String(message).trim());

    return {
      to: normalizedPhone,
      messageId: sentMessage?.id?._serialized || null,
      timestamp: sentMessage?.timestamp || null,
      status: "sent_after_recovery",
    };
  }
}

module.exports = {
  getQrCode,
  getStatus,
  initWhatsAppClient,
  logoutWhatsApp,
  normalizeWhatsAppPhone,
  sendWhatsAppText,
  startWhatsAppAutoInit,
};

