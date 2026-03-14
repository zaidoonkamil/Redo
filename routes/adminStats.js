const express = require("express");
const router = express.Router();
const { Op, fn, col, literal, where } = require("sequelize");
const { User, RideRequest } = require("../models");
const { requireAdmin } = require("./user");
const redisService = require("../services/redis");

const parseRange = (from, to) => {
  let end = to ? new Date(to) : new Date();
  let start = from ? new Date(from) : new Date(end.getTime() - 1000 * 60 * 60 * 24 * 30);
  // normalize
  start = new Date(start);
  end = new Date(end);
  return [start, end];
};

// A) Overview
router.get("/admin/stats/overview", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const [start, end] = parseRange(from, to);

    const totalUsers = await User.count({ where: { role: "user" } });
    const totalDrivers = await User.count({ where: { role: "driver" } });
    const totalRides = await RideRequest.count();

    const statusCounts = await RideRequest.findAll({
      attributes: ["status", [fn("COUNT", col("id")), "count"]],
      where: { createdAt: { [Op.between]: [start, end] } },
      group: ["status"],
    });

    const statusMap = {};
    statusCounts.forEach(r => { statusMap[r.status] = parseInt(r.get("count")); });

    const revenueResult = await RideRequest.findAll({
      attributes: [[fn("SUM", col("estimatedFare")), "totalRevenue"], [fn("AVG", col("estimatedFare")), "avgFare"], [fn("AVG", col("distanceKm")), "avgDistanceKm"]],
      where: { status: "completed", createdAt: { [Op.between]: [start, end] } },
      raw: true,
    });

    const revenue = revenueResult && revenueResult[0] ? revenueResult[0].totalRevenue || 0 : 0;
    const avgFare = revenueResult && revenueResult[0] ? parseFloat(revenueResult[0].avgFare || 0) : 0;
    const avgDistanceKm = revenueResult && revenueResult[0] ? parseFloat(revenueResult[0].avgDistanceKm || 0) : 0;

    // active drivers from Users (status active)
    const activeDriversCount = await User.count({ where: { role: "driver", status: "active" } });

    // online drivers optional from Redis (best-effort)
    let onlineDrivers = null;
    try {
      const redis = await redisService.init();
      const members = await redis.sMembers("drivers:online");
      onlineDrivers = members.length;
    } catch (e) { onlineDrivers = null; }

    res.json({
      totalUsers,
      totalDrivers,
      totalRides,
      ridesByStatus: statusMap,
      activeDrivers: activeDriversCount,
      onlineDrivers,
      revenueTotal: parseFloat(revenue || 0),
      avgFare: parseFloat(avgFare || 0),
      avgDistanceKm: parseFloat(avgDistanceKm || 0),
    });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// B) Timeseries
router.get("/admin/stats/timeseries", requireAdmin, async (req, res) => {
  try {
    const { type = "rides", group = "day", from, to } = req.query;
    const [start, end] = parseRange(from, to);

    let dateExpr;
    if (group === "month") dateExpr = fn("DATE_FORMAT", col("createdAt"), "%Y-%m");
    else dateExpr = fn("DATE", col("createdAt"));

    let whereClause = { createdAt: { [Op.between]: [start, end] } };
    if (type === "users") whereClause.role = "user";
    if (type === "drivers") whereClause.role = "driver";

    if (type === "rides") {
      const rows = await RideRequest.findAll({
        attributes: [[dateExpr, "date"], [fn("COUNT", col("id")), "count"]],
        where: { createdAt: { [Op.between]: [start, end] } },
        group: [literal("date")],
        order: [[literal("date"), "ASC"]],
        raw: true,
      });
      return res.json(rows.map(r => ({ date: r.date, count: parseInt(r.count) })));
    }

    // users or drivers from User
    const rows = await User.findAll({
      attributes: [[dateExpr, "date"], [fn("COUNT", col("id")), "count"]],
      where: whereClause,
      group: [literal("date")],
      order: [[literal("date"), "ASC"]],
      raw: true,
    });

    res.json(rows.map(r => ({ date: r.date, count: parseInt(r.count) })));
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// C) Rides by status
router.get("/admin/stats/rides/by-status", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const [start, end] = parseRange(from, to);
    const rows = await RideRequest.findAll({
      attributes: ["status", [fn("COUNT", col("id")), "count"]],
      where: { createdAt: { [Op.between]: [start, end] } },
      group: ["status"],
      raw: true,
    });
    res.json(rows.map(r => ({ status: r.status, count: parseInt(r.count) })));
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// D) Top drivers
router.get("/admin/stats/top-drivers", requireAdmin, async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const [start, end] = parseRange(from, to);

    const rows = await RideRequest.findAll({
      attributes: [
        "driver_id",
        [fn("SUM", col("estimatedFare")), "totalRevenue"],
        [fn("SUM", literal("(status='completed')")), "completedCount"],
        [fn("SUM", literal("(status='cancelled')")), "cancelledCount"],
      ],
      where: { driver_id: { [Op.not]: null }, createdAt: { [Op.between]: [start, end] } },
      group: ["driver_id"],
      order: [[literal("totalRevenue"), "DESC"]],
      limit: parseInt(limit),
      raw: true,
    });

    const result = [];
    for (const r of rows) {
      const user = await User.findByPk(r.driver_id, { attributes: ["id", "name", "phone", "status"] });
      result.push({ driver: user, completedCount: parseInt(r.completedCount || 0), cancelledCount: parseInt(r.cancelledCount || 0), totalRevenue: parseFloat(r.totalRevenue || 0) });
    }
    res.json(result);
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// E) Top riders
router.get("/admin/stats/top-riders", requireAdmin, async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const [start, end] = parseRange(from, to);

    const rows = await RideRequest.findAll({
      attributes: [
        "rider_id",
        [fn("COUNT", col("id")), "totalRides"],
        [fn("SUM", literal("(status='completed')")), "completedRides"],
        [fn("SUM", col("estimatedFare")), "totalSpend"],
      ],
      where: { rider_id: { [Op.not]: null }, createdAt: { [Op.between]: [start, end] } },
      group: ["rider_id"],
      order: [[literal("totalRides"), "DESC"]],
      limit: parseInt(limit),
      raw: true,
    });

    const result = [];
    for (const r of rows) {
      const user = await User.findByPk(r.rider_id, { attributes: ["id", "name", "phone"] });
      result.push({ rider: user, totalRides: parseInt(r.totalRides || 0), completedRides: parseInt(r.completedRides || 0), totalSpend: parseFloat(r.totalSpend || 0) });
    }
    res.json(result);
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// F) Driver detail
router.get("/admin/stats/driver/:id", requireAdmin, async (req, res) => {
  try {
    const driverId = req.params.id;
    const { from, to } = req.query;
    const [start, end] = parseRange(from, to);

    const counts = await RideRequest.findAll({ attributes: ["status", [fn("COUNT", col("id")), "count"]], where: { driver_id: driverId, createdAt: { [Op.between]: [start, end] } }, group: ["status"], raw: true });
    const map = {}; counts.forEach(c => map[c.status] = parseInt(c.count));

    const revenueRow = await RideRequest.findAll({ attributes: [[fn("SUM", col("estimatedFare")), "totalRevenue"], [fn("AVG", col("distanceKm")), "avgDistanceKm"], [fn("MAX", col("createdAt")), "lastRideAt"]], where: { driver_id: driverId, status: "completed", createdAt: { [Op.between]: [start, end] } }, raw: true });
    const revenue = revenueRow && revenueRow[0] ? parseFloat(revenueRow[0].totalRevenue || 0) : 0;
    const avgDistanceKm = revenueRow && revenueRow[0] ? parseFloat(revenueRow[0].avgDistanceKm || 0) : 0;
    const lastRideAt = revenueRow && revenueRow[0] ? revenueRow[0].lastRideAt : null;

    const user = await User.findByPk(driverId, { attributes: ["id", "name", "phone", "status"] });

    let onlineNow = null;
    try {
      const redis = await redisService.init();
      const sid = await redis.get(`socket:driver:${driverId}`);
      const state = await redis.get(`driver:state:${driverId}`);
      onlineNow = !!(sid || state);
    } catch (e) { onlineNow = null; }

    res.json({ driver: user, counts: map, totalRevenue: revenue, avgDistanceKm, lastRideAt, currentStatus: user?.status, onlineNow });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// G) Rider detail
router.get("/admin/stats/rider/:id", requireAdmin, async (req, res) => {
  try {
    const riderId = req.params.id;
    const { from, to } = req.query;
    const [start, end] = parseRange(from, to);

    const counts = await RideRequest.findAll({ attributes: ["status", [fn("COUNT", col("id")), "count"]], where: { rider_id: riderId, createdAt: { [Op.between]: [start, end] } }, group: ["status"], raw: true });
    const map = {}; counts.forEach(c => map[c.status] = parseInt(c.count));

    const spendRow = await RideRequest.findAll({ attributes: [[fn("SUM", col("estimatedFare")), "totalSpend"], [fn("MAX", col("createdAt")), "lastRideAt"]], where: { rider_id: riderId, status: "completed", createdAt: { [Op.between]: [start, end] } }, raw: true });
    const totalSpend = spendRow && spendRow[0] ? parseFloat(spendRow[0].totalSpend || 0) : 0;
    const lastRideAt = spendRow && spendRow[0] ? spendRow[0].lastRideAt : null;

    res.json({ riderId, counts: map, totalSpend, lastRideAt });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// H) Requests list with pagination
router.get("/admin/stats/requests/list", requireAdmin, async (req, res) => {
  try {
    const { status, from, to, page = 1, limit = 30 } = req.query;
    const [start, end] = parseRange(from, to);
    const where = { createdAt: { [Op.between]: [start, end] } };
    if (status) where.status = status;

    const offset = (page - 1) * limit;
    const { count, rows } = await RideRequest.findAndCountAll({ where, limit: parseInt(limit), offset: parseInt(offset), order: [["createdAt", "DESC"]], include: [{ model: User, as: "rider", attributes: ["id", "name", "phone"] }, { model: User, as: "driver", attributes: ["id", "name", "phone"] }], attributes: ["id", "status", "createdAt", "estimatedFare", "distanceKm"] });

    res.json({ total: count, page: parseInt(page), totalPages: Math.ceil(count / limit), requests: rows });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// /admin/stats/users/overview
router.get("/admin/stats/users/overview", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    const [start, end] = parseRange(from, to);

    const [totalUsers, totalDrivers, pendingDrivers] = await Promise.all([
      User.count({ where: { role: "user" } }),
      User.count({ where: { role: "driver" } }),
      User.count({ where: { role: "driver", status: "pending" } }),
    ]);

    const statusRows = await User.findAll({
      attributes: ["status", [fn("COUNT", col("id")), "count"]],
      where: { createdAt: { [Op.between]: [start, end] } },
      group: ["status"],
      raw: true,
    });
    const usersByStatus = {};
    statusRows.forEach(r => usersByStatus[r.status] = parseInt(r.count));

    let devicesTotal = null;
    let usersWithDevices = null;
    try {
      const { UserDevice } = require("../models");
      devicesTotal = await UserDevice.count();
      const unique = await UserDevice.count({ distinct: true, col: "userId" });
      usersWithDevices = unique;
    } catch (_) {}

    res.json({
      totalUsers,
      totalDrivers,
      pendingDrivers,
      usersByStatus,
      devicesTotal,
      usersWithDevices,
    });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
