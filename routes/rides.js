const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/auth");
const { RideRequest, User, SystemSetting, WalletTransaction } = require("../models");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const { Op } = require("sequelize");
const { buildEstimatedFare } = require("../services/fareCalculator");
const sequelize = require("../config/db");

// ─── Wallet helper (commission + wallet update) ───────────────────────────────────
const centsToDecimal = (c) => (c / 100).toFixed(2);

const applyDriverWalletTx = async ({ userId, type, amountCents, note, metadata, rideRequestId }, t) => {
  const driver = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!driver) throw Object.assign(new Error("driver_not_found"), { code: "driver_not_found" });

  const beforeCents = Math.round(Number(driver.walletBalance || 0) * 100);
  const afterCents = beforeCents + (type === "credit" ? amountCents : -amountCents);
  if (afterCents < 0) throw Object.assign(new Error("wallet_insufficient_balance"), { code: "wallet_insufficient_balance" });

  driver.walletBalance = centsToDecimal(afterCents);
  await driver.save({ transaction: t });

  await WalletTransaction.create({
    user_id: driver.id, type,
    amount: centsToDecimal(amountCents),
    balance_before: centsToDecimal(beforeCents),
    balance_after: centsToDecimal(afterCents),
    reference: rideRequestId ? `ride:${rideRequestId}` : null,
    note: note || null,
    metadata: metadata || null,
    created_by: null,
  }, { transaction: t });

  return { balanceAfter: Number(driver.walletBalance) };
};

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
        attributes: ["id", "role", "status", "serviceType", "walletBalance"],
      });

      if (!driver) continue;
      if (driver.role !== "driver") continue;
      if (driver.status !== "active") continue;
      // فحص رصيد المحفظة: السائق يجب أن يكون لديه رصيد
      if (Number(driver.walletBalance || 0) <= 0) continue;

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

// POST /ride-requests/:id/complete
// السائق يُكمل الرحلة ويحدد طريقة الدفع والأجرة الفعلية
router.post("/ride-requests/:id/complete", authenticateToken, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { paymentMethod, finalFare } = req.body;
    const rideId = Number(req.params.id);

    // التحقق من المدخلات
    if (!["cash", "online"].includes(paymentMethod)) {
      await t.rollback();
      return res.status(400).json({ error: "paymentMethod يجب أن يكون cash أو online" });
    }
    const fare = parseFloat(finalFare);
    if (!Number.isFinite(fare) || fare < 0) {
      await t.rollback();
      return res.status(400).json({ error: "finalFare يجب أن يكون رقم موجب" });
    }

    const ride = await RideRequest.findByPk(rideId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!ride) { await t.rollback(); return res.status(404).json({ error: "الرحلة غير موجودة" }); }
    if (ride.status === "completed") { await t.rollback(); return res.status(400).json({ error: "الرحلة مكتملة مسبقاً" }); }
    if (["cancelled"].includes(ride.status)) { await t.rollback(); return res.status(400).json({ error: "لا يمكن إكمال رحلة ملغاة" }); }

    // التأكد من أن الطالب هو السائق المعين
    if (req.user.role === "driver" && ride.driver_id !== req.user.id) {
      await t.rollback();
      return res.status(403).json({ error: "غير مصرح: أنت لست سائق هذه الرحلة" });
    }

    // احتساب العمولة
    let commissionAmount = 0;
    const commissionTypeSetting = await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_TYPE" }, transaction: t });
    const commissionValueSetting = await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_VALUE" }, transaction: t });
    const commissionType = commissionTypeSetting?.value || "percent";
    const commissionValue = parseFloat(commissionValueSetting?.value || 0);

    if (commissionType === "percent") {
      commissionAmount = (fare * commissionValue) / 100;
    } else {
      commissionAmount = commissionValue;
    }

    const driverEarnings = paymentMethod === "online" ? fare - commissionAmount : 0;
    const commissionCents = Math.round(commissionAmount * 100);
    const earningsCents = Math.round(driverEarnings * 100);

    // تطبيق المحفظة
    let walletResult = null;
    if (paymentMethod === "online" && earningsCents > 0) {
      // أونلاين: نضيف صافي أرباح السائق
      walletResult = await applyDriverWalletTx({
        userId: ride.driver_id,
        type: "credit",
        amountCents: earningsCents,
        note: `أرباح رحلة أونلاين #${ride.id} (بعد خصم عمولة ${commissionAmount.toFixed(2)})`,
        metadata: { source: "ride_online", rideId: ride.id, fare, commission: commissionAmount },
        rideRequestId: ride.id,
      }, t);
    } else if (paymentMethod === "cash" && commissionCents > 0) {
      // كاش: نخصم نسبة الأدمن من محفظة السائق
      walletResult = await applyDriverWalletTx({
        userId: ride.driver_id,
        type: "debit",
        amountCents: commissionCents,
        note: `عمولة رحلة كاش #${ride.id} (من أجرة ${fare})`,
        metadata: { source: "ride_cash", rideId: ride.id, fare, commission: commissionAmount },
        rideRequestId: ride.id,
      }, t);
    }

    // تحديث الرحلة
    ride.status = "completed";
    ride.paymentMethod = paymentMethod;
    ride.finalFare = fare.toFixed(2);
    ride.adminCommission = commissionAmount.toFixed(2);
    ride.driverEarnings = driverEarnings.toFixed(2);
    await ride.save({ transaction: t });
    await t.commit();

    // إزالة الانشغال من Redis
    try {
      const redisClient = await redisService.init();
      await redisClient.del(`driver:busy:${ride.driver_id}`);

      // إخبار الراكب عبر Socket
      await socketService.notifyRiderSocket(ride.rider_id, "trip:status_changed", {
        requestId: ride.id, status: "completed", paymentMethod, finalFare: fare,
      });

      // إخبار السائق بنتيجة المحفظة
      await socketService.notifyDriverSocket(ride.driver_id, "trip:completed", {
        requestId: ride.id, paymentMethod, finalFare: fare,
        commission: commissionAmount, driverEarnings,
        newBalance: walletResult ? walletResult.balanceAfter : null,
      });

      // إذا وصل رصيد السائق لصفر → أخرجه من الأونلاين
      if (walletResult && walletResult.balanceAfter <= 0) {
        await redisClient.del(`driver:state:${ride.driver_id}`);
        await redisClient.sRem("drivers:online", String(ride.driver_id));
        await redisClient.sendCommand(["ZREM", "drivers:geo", String(ride.driver_id)]);
        await socketService.notifyDriverSocket(ride.driver_id, "driver:wallet_blocked", {
          reason: "wallet_empty",
          message: "رصيد محفظتك وصل لصفر. يجب الشحن لاستقبال رحلات جديدة.",
          balance: walletResult.balanceAfter,
        });
      }
    } catch (e) { console.error("post-complete redis/socket error", e.message); }

    return res.status(200).json({
      success: true,
      ride,
      payment: {
        method: paymentMethod,
        finalFare: fare,
        adminCommission: commissionAmount,
        driverEarnings,
        driverWalletBalance: walletResult ? walletResult.balanceAfter : null,
      },
    });
  } catch (err) {
    try { await t.rollback(); } catch (_) {}
    if (err.code === "wallet_insufficient_balance") {
      return res.status(400).json({ error: "رصيد المحفظة غير كافٍ لخصم عمولة الكاش. يجب شحن المحفظة." });
    }
    console.error("❌ complete ride error:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;