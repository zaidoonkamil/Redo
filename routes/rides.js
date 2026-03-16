const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/auth");
const { RideRequest, User } = require("../models");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const { Op } = require("sequelize");
const { buildEstimatedFare } = require("../services/fareCalculator");

// إنشاء طلب رحلة جديد (REST)
router.post("/ride-requests", authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const { pickup, dropoff, serviceType = "normal" } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "pickup and dropoff required" });
    }
    if (!["normal", "vip"].includes(serviceType)) {
      return res.status(400).json({ error: "serviceType must be normal or vip" });
    }

    const bodyDistance = req.body.distanceKm;
    const bodyDuration = req.body.durationMin;

    let dKm =
      bodyDistance != null
        ? parseFloat(bodyDistance)
        : (pickup.distanceKm != null ? parseFloat(pickup.distanceKm) : null);

    let dur =
      bodyDuration != null
        ? parseFloat(bodyDuration)
        : (pickup.durationMin != null ? parseFloat(pickup.durationMin) : null);

    if (!Number.isFinite(dKm)) dKm = null;
    if (!Number.isFinite(dur)) dur = null;

    let estimatedFare = null;

    console.log("[CREATE VIA REST] rider=", req.user?.id);
    console.log("[POST /ride-requests] parsed dKm:", dKm, "parsed dur:", dur);

    if (dKm != null) {
      try {
        estimatedFare = await buildEstimatedFare({
          serviceType,
          distanceKm: dKm,
          durationMin: dur,
        });
      } catch (e) {
        console.error("[POST /ride-requests] fare calc error:", e.message);
      }
    } else {
      console.log("[FARE CHECK REST] skipped: dKm is null");
    }

    const newReq = await RideRequest.create({
      rider_id: user.id,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupAddress: pickup.address || null,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
      dropoffAddress: dropoff.address || null,
      distanceKm: dKm,
      durationMin: dur,
      estimatedFare,
      serviceType,
      status: "pending",
    });

    const redisClient = await redisService.init();
    const radiusMeters = parseInt(req.query.radius, 10) || 5000;

    const raw = await redisClient
      .sendCommand([
        "GEORADIUS",
        "drivers:geo",
        String(pickup.lng),
        String(pickup.lat),
        String(radiusMeters),
        "m",
        "COUNT",
        "30",
        "ASC",
      ])
      .catch(() => []);

    const driverIds = (raw || []).map(String).slice(0, 30);

    for (const did of driverIds) {
      const busyRideId = await redisClient.get(`driver:busy:${did}`);
      if (busyRideId) continue;

      const driver = await User.findByPk(did, {
        attributes: ["id", "role", "status", "serviceType"],
      });

      if (!driver) continue;
      if (driver.role !== "driver") continue;
      if (driver.status !== "active") continue;

      const driverType = driver.serviceType || "normal";

      const canReceive =
        newReq.serviceType === "normal"
          ? ["normal", "vip"].includes(driverType)
          : driverType === "vip";

      if (!canReceive) continue;

      await socketService
        .notifyDriverSocket(did, "request:new", { request: newReq })
        .catch(() => {});
    }

    return res.json({ success: true, request: newReq });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /ride-requests/active
router.get("/ride-requests/active", authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    const activeStatuses = ["pending", "accepted", "arrived", "started"];

    const where =
      user.role === "driver"
        ? { driver_id: user.id, status: { [Op.in]: activeStatuses } }
        : { rider_id: user.id, status: { [Op.in]: activeStatuses } };

    const request = await RideRequest.findOne({
      where,
      order: [["updatedAt", "DESC"]],
    });

    return res.json({ hasActive: !!request, request });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// الحصول على تفاصيل طلب رحلة
router.get("/ride-requests/:id", authenticateToken, async (req, res) => {
  try {
    const reqId = req.params.id;
    const ride = await RideRequest.findByPk(reqId);
    if (!ride) return res.status(404).json({ error: "not_found" });
    res.json({ ride });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// إلغاء طلب رحلة
router.post("/ride-requests/:id/cancel", authenticateToken, async (req, res) => {
  try {
    const reqId = req.params.id;
    const ride = await RideRequest.findByPk(reqId);
    if (!ride) return res.status(404).json({ error: "not_found" });
    if (ride.status === "completed" || ride.status === "cancelled") return res.status(400).json({ error: "cannot_cancel" });
    ride.status = "cancelled";
    await ride.save();
    if (ride.driver_id) {
      await socketService.notifyDriverSocket(
        ride.driver_id,
        "trip:status_changed",
        { requestId: ride.id, status: ride.status }
      );

      const redisClient = await redisService.init();
      await redisClient.del(`driver:busy:${ride.driver_id}`);
    }
    if (ride.driver_id) {
      await socketService.notifyDriverSocket(ride.driver_id, "trip:status_changed", { requestId: ride.id, status: ride.status });
    const redisClient = await redisService.init();
    await redisClient.del(`driver:busy:${ride.driver_id}`);
    }
    res.json({ success: true, ride });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// الحصول على السائقين القريبين
router.get("/drivers/nearby", authenticateToken, async (req, res) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
    const redisClient = await redisService.init();
    const raw = await redisClient.sendCommand(["GEORADIUS", "drivers:geo", String(lng), String(lat), String(radius), "m", "COUNT", "30", "ASC"]).catch(() => []);
    const driverIds = (raw || []).map(String).slice(0, 30);
    const list = [];
    for (const did of driverIds) {
      const loc = await redisService.getJSON(`driver:loc:${did}`);
      list.push({ driverId: did, loc });
    }
    res.json({ drivers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ride-requests/user/:userId
router.get("/ride-requests/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, page = 1, limit = 20,} = req.query;

    const where = { rider_id: userId };
    if (status) where.status = status;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows, count } = await RideRequest.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    return res.json({
      success: true,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      rides: rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /ride-requests/driver/:driverId
router.get("/ride-requests/driver/:driverId", async (req, res) => {
  try {
    const { driverId } = req.params;
    const {
      status,
      page = 1,
      limit = 20,
    } = req.query;

    const where = { driver_id: driverId };
    if (status) where.status = status;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows, count } = await RideRequest.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: parseInt(limit),
      offset,
    });

    return res.json({
      success: true,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      rides: rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;