const express = require("express");
const router = express.Router();
const { PricingSetting, PricingTier, RideRequest, User } = require("../models");
const { Op } = require("sequelize");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");
const sequelize = require("../config/db");

const TIER_EPSILON = 1e-4;

const validateTierPayload = (tiers) => {
  if (!Array.isArray(tiers) || !tiers.length) {
    throw new Error("tiers array required");
  }

  const normalized = tiers
    .map((tier, idx) => ({
      idx,
      fromKm: parseFloat(tier.fromKm),
      toKm: tier.toKm == null ? null : parseFloat(tier.toKm),
      pricePerKm: parseFloat(tier.pricePerKm),
    }))
    .sort((a, b) => a.fromKm - b.fromKm);

  const first = normalized[0];
  if (!Number.isFinite(first.fromKm) || Math.abs(first.fromKm - 0) > TIER_EPSILON) {
    throw new Error("first tier must start at 0 km");
  }

  let prevEnd = null;

  normalized.forEach((tier, index) => {
    if (!Number.isFinite(tier.fromKm) || tier.fromKm < 0) {
      throw new Error(`tier ${index + 1} has invalid fromKm`);
    }
    if (tier.toKm != null && (!Number.isFinite(tier.toKm) || tier.toKm <= tier.fromKm)) {
      throw new Error(`tier ${index + 1} must have toKm greater than fromKm`);
    }
    if (tier.pricePerKm == null || !Number.isFinite(tier.pricePerKm) || tier.pricePerKm <= 0) {
      throw new Error(`tier ${index + 1} pricePerKm must be > 0`);
    }

    if (index === 0) {
      prevEnd = tier.toKm;
    } else {
      if (prevEnd == null) {
        throw new Error("open-ended tier must be last");
      }
      if (Math.abs(tier.fromKm - prevEnd) > TIER_EPSILON) {
        throw new Error(`tier ${index + 1} must start where previous tier ends`);
      }
      prevEnd = tier.toKm;
    }

    if (tier.toKm == null && index !== normalized.length - 1) {
      throw new Error("only last tier can have open-ended range");
    }
  });

  const last = normalized[normalized.length - 1];
  if (last.toKm != null) {
    throw new Error("last tier must be open-ended (toKm = null)");
  }

  return normalized.map(({ fromKm, toKm, pricePerKm }) => ({ fromKm, toKm, pricePerKm }));
};

// Get current pricing (latest)
router.get("/admin/pricing", async (req, res) => {
  try {
    const { serviceType = "normal" } = req.query;

    if (!["normal", "vip"].includes(serviceType)) {
      return res.status(400).json({ error: "invalid serviceType" });
    }

    const pricing = await PricingSetting.findOne({
      where: { serviceType },
      order: [["createdAt", "DESC"]],
    });

    if (!pricing) return res.json({ pricing: null });
    res.json({ pricing });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update pricing (create new record)
router.put("/admin/pricing", async (req, res) => {
  try {
    const {
      serviceType,
      baseFare,
      pricePerKm,
      pricePerMinute,
      minimumFare,
      surgeEnabled,
      surgeMultiplier
    } = req.body;

    if (!["normal", "vip"].includes(serviceType)) {
      return res.status(400).json({ error: "invalid serviceType" });
    }

    if (baseFare == null || pricePerKm == null) {
      return res.status(400).json({ error: "baseFare and pricePerKm are required" });
    }

    const newRec = await PricingSetting.create({
      serviceType,
      baseFare,
      pricePerKm,
      pricePerMinute: pricePerMinute != null ? pricePerMinute : null,
      minimumFare: minimumFare != null ? minimumFare : null,
      surgeEnabled: !!surgeEnabled,
      surgeMultiplier: surgeMultiplier != null ? surgeMultiplier : 1,
      updatedByAdminId: req.user.id,
    });

    res.json({ success: true, pricing: newRec });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get pricing tiers per service type
router.get("/admin/pricing/tiers", async (req, res) => {
  try {
    const { serviceType = "normal" } = req.query;
    if (!["normal", "vip"].includes(serviceType)) {
      return res.status(400).json({ error: "invalid serviceType" });
    }

    const tiers = await PricingTier.findAll({
      where: { serviceType },
      order: [["fromKm", "ASC"]],
    });

    return res.json({ tiers });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Replace pricing tiers for a service type
router.put("/admin/pricing/tiers", async (req, res) => {
  try {
    const { serviceType, tiers } = req.body;
    if (!["normal", "vip"].includes(serviceType)) {
      return res.status(400).json({ error: "invalid serviceType" });
    }

    let normalized;
    try {
      normalized = validateTierPayload(tiers);
    } catch (err) {
      return res.status(400).json({ error: "invalid_tiers", message: err.message });
    }

    const t = await sequelize.transaction();
    try {
      await PricingTier.destroy({ where: { serviceType }, transaction: t });
      const payload = normalized.map((tier) => ({ ...tier, serviceType }));
      await PricingTier.bulkCreate(payload, { transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    const fresh = await PricingTier.findAll({
      where: { serviceType },
      order: [["fromKm", "ASC"]],
    });

    return res.json({ success: true, tiers: fresh });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Admin: list ride requests with filters
router.get("/admin/ride-requests", async (req, res) => {
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
router.get("/admin/ride-requests/:id", async (req, res) => {
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
router.patch("/admin/ride-requests/:id/status", async (req, res) => {
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
router.post("/admin/ride-requests/:id/assign-driver", async (req, res) => {
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
router.get("/admin/drivers/online", async (req, res) => {
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
router.get("/admin/stats/summary", async (req, res) => {
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
