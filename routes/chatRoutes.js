const express = require("express");
const router = express.Router();
const { ChatMessage, User } = require("../models");
const { Op } = require("sequelize");
const { sendNotificationToRole } = require("../services/notifications.js"); 
const { sendNotificationToUser } = require("../services/notifications.js"); 

function initChatSocket(chatIO) {
  const userSockets = new Map();

  chatIO.on("connection", (socket) => {
    const { userId } = socket.handshake.query;
    if (!userId) return socket.disconnect(true);

    console.log(`💬 [chat] مستخدم متصل: ${userId}`);

    const key = userId.toString();
    if (!userSockets.has(key)) userSockets.set(key, []);
    userSockets.get(key).push(socket.id);

    socket.on("getMessages", async (payload = {}) => {
      try {
        const { userId, receiverId } = payload;
        if (!userId) return;

        if (receiverId) {
          const messages = await ChatMessage.findAll({
            where: {
              [Op.or]: [
                { senderId: userId, receiverId },
                { senderId: receiverId, receiverId: userId },
              ],
            },
            order: [["createdAt", "ASC"]],
            include: [
              { model: User, as: "sender", attributes: ["id", "name", "role"] },
              { model: User, as: "receiver", attributes: ["id", "name", "role"] },
            ],
          });
          return socket.emit("messagesLoaded", messages);
        }

        const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
        const adminIds = admins.map((a) => a.id);

        const messages = await ChatMessage.findAll({
          where: {
            [Op.or]: [
              { senderId: userId, receiverId: null },
              { senderId: userId, receiverId: { [Op.in]: adminIds } },
              { senderId: { [Op.in]: adminIds }, receiverId: userId },
            ],
          },
          order: [["createdAt", "ASC"]],
          include: [
            { model: User, as: "sender", attributes: ["id", "name", "role"] },
            { model: User, as: "receiver", attributes: ["id", "name", "role"] },
          ],
        });

        socket.emit("messagesLoaded", messages);
      } catch (err) {
        console.error("❌ خطأ في جلب الرسائل:", err);
      }
    });

    socket.on("sendMessage", async (data) => {
      try {
        const { senderId, receiverId, message } = data;
        if (!senderId || !message) return;

        const newMessage = await ChatMessage.create({
          senderId,
          receiverId: receiverId || null,
          message,
        });

        const fullMessage = await ChatMessage.findOne({
          where: { id: newMessage.id },
          include: [
            { model: User, as: "sender", attributes: ["id", "name", "role"] },
            { model: User, as: "receiver", attributes: ["id", "name", "role"] },
          ],
        });

        let recipients = [];
        if (!receiverId) {
          const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
          recipients = [...admins.map((a) => a.id), senderId];

          await sendNotificationToRole(
            "admin",
            fullMessage.message,
            `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
          );
        } else {
          recipients = [senderId, receiverId];
          if (fullMessage.sender?.role === "admin") {
            await sendNotificationToUser(
              receiverId,
              fullMessage.message,
              `رسالة جديدة من الأدمن ${fullMessage.sender?.name || ""}`
            );
          }
        }

        recipients.forEach((id) => {
          const sockets = userSockets.get(id.toString()) || [];
          sockets.forEach((sid) => chatIO.to(sid).emit("newMessage", fullMessage));
        });
      } catch (err) {
        console.error("❌ خطأ في إرسال الرسالة:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log(`💬 [chat] مستخدم قطع الاتصال: ${userId}`);
      const sockets = userSockets.get(key) || [];
      userSockets.set(key, sockets.filter((id) => id !== socket.id));
    });
  });
}

router.get("/usersWithLastMessage", async (req, res) => {
  try {
    const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
    const adminIds = admins.map(a => a.id);

    const messages = await ChatMessage.findAll({
      where: {
        [Op.or]: [
          { senderId: { [Op.notIn]: adminIds }, receiverId: { [Op.in]: adminIds } }, 
          { senderId: { [Op.in]: adminIds }, receiverId: { [Op.notIn]: adminIds } }, 
          { senderId: { [Op.notIn]: adminIds }, receiverId: null },
        ],
      },
      include: [
        { model: User, as: "sender", attributes: ["id", "name"] },
        { model: User, as: "receiver", attributes: ["id", "name"] },
      ],
      order: [["createdAt", "DESC"]],
      limit: 50,
    });

    const usersMap = new Map();

    messages.forEach(msg => {
      if (!adminIds.includes(msg.senderId) && msg.sender) {
        if (!usersMap.has(msg.senderId)) {
          usersMap.set(msg.senderId, { user: msg.sender, lastMessage: msg });
        }
      }

      // إذا المستقبل ليس أدمن ونفس الرسالة ليست null
      if (msg.receiverId && !adminIds.includes(msg.receiverId) && msg.receiver) {
        if (!usersMap.has(msg.receiverId)) {
          usersMap.set(msg.receiverId, { user: msg.receiver, lastMessage: msg });
        }
      }
    });

    res.json(Array.from(usersMap.values()));
  } catch (err) {
    console.error("❌ خطأ في جلب المستخدمين مع آخر رسالة:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب المستخدمين" });
  }
});



module.exports = { router, initChatSocket };