const express = require("express");
const multer = require("multer");
const { User } = require("../models");
const { requireAdmin } = require("../middlewares/auth.js");
const {
  getQrCode,
  getStatus,
  initWhatsAppClient,
  logoutWhatsApp,
  normalizeWhatsAppPhone,
  sendWhatsAppText,
} = require("../services/waSender");

const router = express.Router();
const upload = multer();

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

router.post("/whatsapp/init", requireAdmin, async (req, res) => {
  try {
    const status = await initWhatsAppClient();
    return res.status(200).json({ success: true, ...status });
  } catch (error) {
    console.error("WhatsApp init error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get("/whatsapp/status", requireAdmin, async (req, res) => {
  return res.status(200).json({ success: true, ...getStatus() });
});

router.get("/whatsapp/qr", requireAdmin, async (req, res) => {
  try {
    const qr = await getQrCode();
    return res.status(200).json({ success: true, ...qr });
  } catch (error) {
    console.error("WhatsApp QR error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.post("/whatsapp/logout", requireAdmin, async (req, res) => {
  try {
    const result = await logoutWhatsApp();
    return res.status(200).json(result);
  } catch (error) {
    console.error("WhatsApp logout error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.post("/whatsapp/send", requireAdmin, upload.none(), async (req, res) => {
  try {
    const { user_id, phone, message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    let targetPhone = phone;
    let user = null;

    if (!targetPhone && user_id) {
      user = await User.findByPk(user_id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      targetPhone = user.phone;
    }

    if (!targetPhone) {
      return res.status(400).json({ error: "phone or user_id is required" });
    }

    const result = await sendWhatsAppText(targetPhone, message);

    return res.status(200).json({
      success: true,
      phone: result.to,
      user_id: user ? user.id : null,
      messageId: result.messageId,
      timestamp: result.timestamp,
      status: result.status,
    });
  } catch (error) {
    console.error("WhatsApp send error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.post("/whatsapp/send-bulk", requireAdmin, upload.none(), async (req, res) => {
  try {
    const { message } = req.body;
    const phones = parseList(req.body.phones);
    const userIds = parseList(req.body.user_ids);

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    if (!phones.length && !userIds.length) {
      return res.status(400).json({ error: "phones or user_ids is required" });
    }

    const targets = new Map();

    for (const rawPhone of phones) {
      const normalizedPhone = normalizeWhatsAppPhone(rawPhone);
      targets.set(normalizedPhone, { phone: normalizedPhone, user_id: null });
    }

    if (userIds.length) {
      const users = await User.findAll({ where: { id: userIds } });

      for (const user of users) {
        if (!user.phone) continue;
        const normalizedPhone = normalizeWhatsAppPhone(user.phone);
        targets.set(normalizedPhone, { phone: normalizedPhone, user_id: user.id });
      }
    }

    const results = [];

    for (const target of targets.values()) {
      try {
        const sendResult = await sendWhatsAppText(target.phone, message);
        results.push({
          success: true,
          phone: target.phone,
          user_id: target.user_id,
          messageId: sendResult.messageId,
          timestamp: sendResult.timestamp,
        });
      } catch (error) {
        results.push({
          success: false,
          phone: target.phone,
          user_id: target.user_id,
          error: error.message,
        });
      }
    }

    const sent = results.filter((item) => item.success).length;

    return res.status(200).json({
      success: true,
      total: results.length,
      sent,
      failed: results.length - sent,
      results,
    });
  } catch (error) {
    console.error("WhatsApp bulk send error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;

