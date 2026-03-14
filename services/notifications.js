const { User, UserDevice } = require("../models");
const NotificationLog = require("../models/notification_log");
const axios = require("axios");

const sendNotificationToDevices = async (playerIds, message, title = "Notification") => {
  const url = 'https://onesignal.com/api/v1/notifications';
  const headers = {
    'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const data = {
    app_id: process.env.ONESIGNAL_APP_ID,
    include_player_ids: playerIds,
    contents: { en: message },
    headings: { en: title },
  };

  return axios.post(url, data, { headers });
};

const sendNotificationToAll = async (message, title = "Notification") => {
  const users = await User.findAll({ attributes: ["id"] });
  for (const user of users) {
    const devices = await UserDevice.findAll({ where: { user_id: user.id } });
    const playerIds = devices.map(d => d.player_id);

    const logData = {
      title,
      message,
      target_type: "user",
      target_value: user.id.toString(),
      user_id: user.id, 
    };

    if (playerIds.length === 0) {
      logData.status = "failed";
      await NotificationLog.create(logData);
      continue;
    }

    try {
      await sendNotificationToDevices(playerIds, message, title);
      logData.status = "sent";
      await NotificationLog.create(logData);
    } catch (err) {
      console.error(`❌ Error sending notification to user ${user.id}:`, err.message);
      logData.status = "failed";
      await NotificationLog.create(logData);
    }
  }
};

const sendNotificationToRole = async (role, message, title = "Notification") => {
  const devices = await UserDevice.findAll({
    include: [{ model: User, as: "user", where: { role } }]
  });

  const devicesByUser = {};
  devices.forEach(d => {
    if (!devicesByUser[d.user_id]) devicesByUser[d.user_id] = [];
    devicesByUser[d.user_id].push(d.player_id);
  });

  for (const [userId, playerIds] of Object.entries(devicesByUser)) {
    const logData = {
      title,
      message,
      target_type: "user",
      target_value: userId.toString(),
      user_id: parseInt(userId), 
    };

    try {
      await sendNotificationToDevices(playerIds, message, title);
      logData.status = "sent";
      await NotificationLog.create(logData);
    } catch (err) {
      console.error(`❌ Error sending notification to user ${userId}:`, err.message);
      logData.status = "failed";
      await NotificationLog.create(logData);
    }
  }
};

const sendNotificationToUser = async (userId, message, title = "Notification") => {
  const devices = await UserDevice.findAll({
    where: { user_id: userId }  
  });

  console.log("🔎 Devices for user:", userId, devices.map(d => d.toJSON()));

  const playerIds = devices.map(d => d.player_id);

  const logData = {
    title,
    message,
    target_type: "user",
    target_value: userId.toString(),
    user_id: userId,
  };

  if (playerIds.length === 0) {
    logData.status = "failed";
    await NotificationLog.create(logData);
    return { success: false, message: `لا توجد أجهزة للمستخدم ${userId}` };
  }

  try {
    await sendNotificationToDevices(playerIds, message, title);
    logData.status = "sent";
    await NotificationLog.create(logData);
    return { success: true };
  } catch (err) {
    console.error(`❌ Error sending notification to user ${userId}:`, err.message);
    logData.status = "failed";
    await NotificationLog.create(logData);
    return { success: false, error: err.message };
  }
};



module.exports = {
  sendNotificationToAll,
  sendNotificationToRole,
  sendNotificationToUser
};
