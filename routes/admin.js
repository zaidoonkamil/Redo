const express = require("express");
const router = express.Router();
const { requireAdmin } = require("./user");
const { PricingSetting, PricingTier, RideRequest, User, WalletTransaction } = require("../models");
const { Op } = require("sequelize");
const redisService = require("../services/redis");
const socketService = require("../services/socket");
const notifications = require("../services/notifications");
const sequelize = require("../config/db");

// ─── Wallet helpers (mirrored from user.js) ────────────────────────────────
const parseAmountToCents = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
};
const centsToDecimal = (cents) => (cents / 100).toFixed(2);

const applyWalletTx = async ({ userId, type, amountCents, reference, note, metadata, createdBy }) => {
  if (!["credit", "debit"].includes(type)) throw new Error("invalid_wallet_transaction_type");
  return sequelize.transaction(async (t) => {
    const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!user) { const e = new Error("wallet_user_not_found"); e.code = "wallet_user_not_found"; throw e; }
    const beforeCents = Math.round(Number(user.walletBalance || 0) * 100);
    const afterCents = beforeCents + (type === "credit" ? amountCents : -amountCents);
    if (afterCents < 0) { const e = new Error("wallet_insufficient_balance"); e.code = "wallet_insufficient_balance"; throw e; }
    user.walletBalance = centsToDecimal(afterCents);
    await user.save({ transaction: t });
    const tx = await WalletTransaction.create({
      user_id: user.id, type,
      amount: centsToDecimal(amountCents),
      balance_before: centsToDecimal(beforeCents),
      balance_after: centsToDecimal(afterCents),
      reference: reference || null,
      note: note || null,
      metadata: metadata || null,
      created_by: createdBy || null,
    }, { transaction: t });
    return { user, tx };
  });
};

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
router.get("/admin/pricing", requireAdmin, async (req, res) => {
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
router.put("/admin/pricing", requireAdmin, async (req, res) => {
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
router.get("/admin/pricing/tiers", requireAdmin, async (req, res) => {
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
router.put("/admin/pricing/tiers", requireAdmin, async (req, res) => {
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

// ─── Admin Wallet Management ────────────────────────────────────────────────

// GET /admin/users/:id/wallet
// عرض رصيد المحفظة لمستخدم معين (أدمن فقط)
router.get("/admin/users/:id/wallet", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "معرّف المستخدم غير صحيح" });
    }

    const user = await User.findByPk(userId, {
      attributes: ["id", "name", "phone", "role", "walletBalance"],
    });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    return res.status(200).json({
      wallet: {
        userId: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        balance: Number(user.walletBalance || 0),
      },
    });
  } catch (err) {
    console.error("❌ Error fetching user wallet:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /admin/users/:id/wallet/transactions
// عرض سجل معاملات المحفظة لمستخدم معين (أدمن فقط)
router.get("/admin/users/:id/wallet/transactions", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "معرّف المستخدم غير صحيح" });
    }

    const user = await User.findByPk(userId, {
      attributes: ["id", "name", "phone", "role", "walletBalance"],
    });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const offset = (page - 1) * limit;
    const type = req.query.type;

    const where = { user_id: userId };
    if (type) {
      if (!["credit", "debit"].includes(type)) {
        return res.status(400).json({ error: "type غير صحيح (credit | debit)" });
      }
      where.type = type;
    }

    const { count, rows } = await WalletTransaction.findAndCountAll({
      where,
      limit,
      offset,
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      wallet: {
        userId: user.id,
        name: user.name,
        balance: Number(user.walletBalance || 0),
      },
      transactions: rows,
      pagination: {
        total: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching wallet transactions:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /admin/users/:id/wallet/credit
// شحن محفظة مستخدم (أدمن فقط)
router.post("/admin/users/:id/wallet/credit", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "معرّف المستخدم غير صحيح" });
    }

    const amountCents = parseAmountToCents(req.body.amount);
    if (!amountCents) {
      return res.status(400).json({ error: "amount يجب أن يكون أكبر من 0" });
    }

    const { reference, note } = req.body;

    const { user, tx } = await applyWalletTx({
      userId,
      type: "credit",
      amountCents,
      reference,
      note,
      metadata: { source: "admin_credit", adminId: req.user.id },
      createdBy: req.user.id,
    });

    return res.status(200).json({
      message: "تم شحن المحفظة بنجاح",
      wallet: {
        userId: user.id,
        name: user.name,
        balance: Number(user.walletBalance || 0),
      },
      transaction: tx,
    });
  } catch (err) {
    if (err.code === "wallet_user_not_found") {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }
    console.error("❌ Error crediting wallet:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /admin/users/:id/wallet/debit
// خصم من محفظة مستخدم (أدمن فقط)
router.post("/admin/users/:id/wallet/debit", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "معرّف المستخدم غير صحيح" });
    }

    const amountCents = parseAmountToCents(req.body.amount);
    if (!amountCents) {
      return res.status(400).json({ error: "amount يجب أن يكون أكبر من 0" });
    }

    const { reference, note } = req.body;

    const { user, tx } = await applyWalletTx({
      userId,
      type: "debit",
      amountCents,
      reference,
      note,
      metadata: { source: "admin_debit", adminId: req.user.id },
      createdBy: req.user.id,
    });

    return res.status(200).json({
      message: "تم خصم الرصيد بنجاح",
      wallet: {
        userId: user.id,
        name: user.name,
        balance: Number(user.walletBalance || 0),
      },
      transaction: tx,
    });
  } catch (err) {
    if (err.code === "wallet_user_not_found") {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }
    if (err.code === "wallet_insufficient_balance") {
      return res.status(400).json({ error: "الرصيد غير كافٍ لإجراء الخصم" });
    }
    console.error("❌ Error debiting wallet:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Admin: Database Migration ──────────────────────────────────────────────
// POST /admin/migrate/run
// يضيف الأعمدة الناقصة في قاعدة البيانات (آمن - لا يُعيد إنشاء شيء موجود)
router.post("/admin/migrate/run", requireAdmin, async (req, res) => {
  const results = [];

  const safeAlter = async (label, sql) => {
    try {
      await sequelize.query(sql);
      results.push({ column: label, status: "✅ added or already exists" });
    } catch (err) {
      // خطأ 1060 = العمود موجود مسبقاً (Duplicate column name) - نتجاهله
      if (err.original?.errno === 1060 || err.parent?.errno === 1060) {
        results.push({ column: label, status: "⚠️ already exists (skipped)" });
      } else {
        results.push({ column: label, status: `❌ error: ${err.message}` });
      }
    }
  };

  // ─── ride_requests ────────────────────────────────────────────────────────
  await safeAlter(
    "ride_requests.paymentMethod",
    `ALTER TABLE ride_requests ADD COLUMN paymentMethod ENUM('cash','online') NULL DEFAULT NULL`
  );
  await safeAlter(
    "ride_requests.finalFare",
    `ALTER TABLE ride_requests ADD COLUMN finalFare DECIMAL(14,2) NULL DEFAULT NULL`
  );
  await safeAlter(
    "ride_requests.adminCommission",
    `ALTER TABLE ride_requests ADD COLUMN adminCommission DECIMAL(14,2) NULL DEFAULT NULL`
  );
  await safeAlter(
    "ride_requests.driverEarnings",
    `ALTER TABLE ride_requests ADD COLUMN driverEarnings DECIMAL(14,2) NULL DEFAULT NULL`
  );

  // ─── Users (walletBalance - قد يكون موجود مسبقًا) ────────────────────────
  await safeAlter(
    "users.walletBalance",
    `ALTER TABLE Users ADD COLUMN walletBalance DECIMAL(14,2) NOT NULL DEFAULT 0`
  );

  const hasError = results.some((r) => r.status.startsWith("❌"));
  return res.status(hasError ? 500 : 200).json({
    message: hasError ? "بعض الأعمدة فشلت" : "✅ المايغريشن اكتمل",
    results,
  });
});

module.exports = router;
