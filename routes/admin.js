const express = require("express");
const router = express.Router();
const { requireAdmin } = require("./user");
const { PricingSetting, RideRequest, User } = require("../models");
const { Op } = require("sequelize");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");

// Get current pricing (latest)
router.get("/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const pricing = await PricingSetting.findOne({ order: [["createdAt", "DESC"]] });
    if (!pricing) return res.json({ pricing: null });
    res.json({ pricing });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Update pricing (create new record)
router.put("/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const { baseFare, pricePerKm, pricePerMinute, minimumFare, surgeEnabled, surgeMultiplier } = req.body;
    if (baseFare == null || pricePerKm == null) return res.status(400).json({ error: "baseFare and pricePerKm are required" });

    const newRec = await PricingSetting.create({
      baseFare,
      pricePerKm,
      pricePerMinute: pricePerMinute != null ? pricePerMinute : null,
      minimumFare: minimumFare != null ? minimumFare : null,
      surgeEnabled: !!surgeEnabled,
      surgeMultiplier: surgeMultiplier != null ? surgeMultiplier : 1,
      updatedByAdminId: req.user.id,
    });

    res.json({ success: true, pricing: newRec });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: list ride requests with filters
router.get("/admin/ride-requests", requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 30, from, to, rider_id, driver_id } = req.query;
    const where = {};
    if (status) where.status = status;
    if (rider_id) where.rider_id = rider_id;
    if (driver_id) where.driver_id = driver_id;
    if (from || to) where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(from);
    if (to) where.createdAt[Op.lte] = new Date(to);

    const offset = (page - 1) * limit;
    const { count, rows } = await RideRequest.findAndCountAll({ where, limit: parseInt(limit), offset, order: [["createdAt", "DESC"]] });
    res.json({ total: count, page: parseInt(page), totalPages: Math.ceil(count / limit), rides: rows });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: get ride details
router.get("/admin/ride-requests/:id", requireAdmin, async (req, res) => {
  try {
    const ride = await RideRequest.findByPk(req.params.id, { include: [
      { model: User, as: "rider", attributes: { exclude: ["password"] } },
      { model: User, as: "driver", attributes: { exclude: ["password"] } }
    ] });
    if (!ride) return res.status(404).json({ error: "not_found" });
    res.json({ ride });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: change status with validations
router.patch("/admin/ride-requests/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });
    const ride = await RideRequest.findByPk(req.params.id);
    if (!ride) return res.status(404).json({ error: "not_found" });
    if (["completed", "cancelled"].includes(ride.status)) return res.status(400).json({ error: "cannot_change_final_status" });
    if (ride.status === "completed" && status === "pending") return res.status(400).json({ error: "invalid_transition" });

    ride.status = status;
    await ride.save();

    // notify
    try {
      if (ride.rider_id) {
        const ok = await socketService.notifyRiderSocket(ride.rider_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
        if (!ok) await notifications.sendNotificationToUser(ride.rider_id, `حالة الرحلة تغيرت إلى ${ride.status}`);
      }
      if (ride.driver_id) {
        const ok2 = await socketService.notifyDriverSocket(ride.driver_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
        if (!ok2) await notifications.sendNotificationToUser(ride.driver_id, `حالة الرحلة تغيرت إلى ${ride.status}`);
      }
    } catch (e) {}

    res.json({ success: true, ride });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: assign driver to pending ride
router.post("/admin/ride-requests/:id/assign-driver", requireAdmin, async (req, res) => {
  const t = await RideRequest.sequelize.transaction();
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: "driverId required" });
    const ride = await RideRequest.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!ride) { await t.rollback(); return res.status(404).json({ error: "not_found" }); }
    if (ride.status !== "pending") { await t.rollback(); return res.status(400).json({ error: "ride_not_pending" }); }

    ride.driver_id = driverId;
    ride.status = "accepted";
    await ride.save({ transaction: t });
    await t.commit();

    // notify rider and driver
    try {
      const riderNotified = await socketService.notifyRiderSocket(ride.rider_id, "request:accepted", { requestId: ride.id, driverId });
      if (!riderNotified) await notifications.sendNotificationToUser(ride.rider_id, "تم تعيين سائق لطلبك");

      const driverNotified = await socketService.notifyDriverSocket(driverId, "request:assigned", { request: ride });
      if (!driverNotified) await notifications.sendNotificationToUser(driverId, "تم تعيين طلب لك");
    } catch (e) { console.error(e.message); }

    res.json({ success: true, ride });
  } catch (e) { await t.rollback(); console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: online drivers (lightweight)
router.get("/admin/drivers/online", requireAdmin, async (req, res) => {
  try {
    const redis = await redisService.init();
    const ids = await redis.sMembers("drivers:online").catch(() => []);
    const list = [];
    for (const id of ids) {
      const loc = await redis.get(`driver:loc:${id}`).catch(() => null);
      const last = loc ? JSON.parse(loc) : null;
      const user = await User.findByPk(id, { attributes: { exclude: ["password"] } }).catch(() => null);
      list.push({ driverId: id, user, loc: last });
    }
    res.json({ drivers: list });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Admin: simple stats
router.get("/admin/stats/summary", requireAdmin, async (req, res) => {
  try {
    const usersCount = await User.count({ where: { role: { [Op.not]: "admin" } } });
    const driversCount = await User.count({ where: { role: "driver" } });
    const today = new Date();
    today.setHours(0,0,0,0);
    const ridesToday = await RideRequest.count({ where: { createdAt: { [Op.gte]: today } } });
    const pending = await RideRequest.count({ where: { status: "pending" } });
    const completed = await RideRequest.count({ where: { status: "completed" } });
    res.json({ users: usersCount, drivers: driversCount, ridesToday, pending, completed });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
