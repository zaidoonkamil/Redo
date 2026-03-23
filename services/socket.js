const jwt = require("jsonwebtoken");
const redisService = require("./redis");
const { User, RideRequest, SystemSetting, WalletTransaction } = require("../models");
const sequelize = require("../config/db");
const notifications = require("./notifications") || require("../services/notifications");
const { Op } = require("sequelize");
const { buildEstimatedFare } = require("./fareCalculator");

// ─── Wallet helpers ───────────────────────────────────────────────────────────
const centsToDecimal = (cents) => (cents / 100).toFixed(2);

const applyDriverWalletTx = async ({ userId, type, amountCents, note, metadata, rideRequestId }) => {
  return sequelize.transaction(async (t) => {
    const driver = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!driver) throw Object.assign(new Error("driver_not_found"), { code: "driver_not_found" });

    const beforeCents = Math.round(Number(driver.walletBalance || 0) * 100);
    const afterCents = beforeCents + (type === "credit" ? amountCents : -amountCents);

    if (afterCents < 0) throw Object.assign(new Error("wallet_insufficient_balance"), { code: "wallet_insufficient_balance" });

    driver.walletBalance = centsToDecimal(afterCents);
    await driver.save({ transaction: t });

    await WalletTransaction.create({
      user_id: driver.id,
      type,
      amount: centsToDecimal(amountCents),
      balance_before: centsToDecimal(beforeCents),
      balance_after: centsToDecimal(afterCents),
      reference: rideRequestId ? `ride:${rideRequestId}` : null,
      note: note || null,
      metadata: metadata || null,
      created_by: null,
    }, { transaction: t });

    return { driver, balanceAfter: Number(driver.walletBalance) };
  });
};

let ioInstance = null;


function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}


const init = async (io) => {
  ioInstance = io;

  const redisClient = await redisService.init();

  io.on("connection", async (socket) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        socket.disconnect(true);
        return;
      }

      let user;
      try {
        user = jwt.verify(token, process.env.JWT_SECRET);
      } catch (e) {
        socket.disconnect(true);
        return;
      }

      socket.user = user;

      const isDriver = user.role === "driver";
      const socketKey = isDriver ? `socket:driver:${user.id}` : `socket:rider:${user.id}`;
      await redisClient.set(socketKey, socket.id, { EX: 3600  });
        const refreshSocketKey = async () => {
          try {
            await redisClient.set(socketKey, socket.id, { EX: 3600 });
          } catch (e) {
            console.error("refreshSocketKey error", e.message);
          }
        };
        
        socket.onAny(async () => {
          await refreshSocketKey();
        });
        
        // رفض الطلب من قبل السائق
      socket.on("driver:reject_request", async ({ requestId }) => {
        try {
          if (!requestId) return;

          const key = `request:rejected:${requestId}`;
          await redisClient.sAdd(key, String(user.id));
          await redisClient.expire(key, 3600);

          socket.emit("request:rejected_ack", { ok: true, requestId });
        } catch (e) {
          console.error("driver:reject_request error", e.message);
          socket.emit("request:rejected_ack", { ok: false, error: e.message });
        }
      });

      socket.on("disconnect", async () => {
          try {
            await redisClient.del(socketKey);
            if (isDriver) {
              await redisClient.del(`driver:state:${user.id}`);
              try { await redisClient.sRem("drivers:online", String(user.id)); } catch (e) {}
              await redisClient.sendCommand(["ZREM", "drivers:geo", String(user.id)]);
              await redisClient.del(`driver:loc:${user.id}`);
            }
          } catch (e) {
            console.error("socket disconnect cleanup", e.message);
          }
      });

      // اتصال السائق
      socket.on("driver:online", async () => {
        try {
          // فحص رصيد المحفظة - السائق يجب أن يكون رصيده > 0 ليتمكن من العمل
          const driver = await User.findByPk(user.id, { attributes: ["id", "walletBalance", "isDebtBlocked"] });
          if (!driver) return;

          const balance = Number(driver.walletBalance || 0);
          if (balance <= 0) {
            socket.emit("driver:wallet_blocked", { ok: false, reason: "wallet_empty", balance });
            return;
          }

          await redisClient.set(`driver:state:${user.id}`, "online", { EX: 3600 });
          await redisClient.sAdd("drivers:online", String(user.id));
          await redisClient.set(socketKey, socket.id, { EX: 3600 });
          socket.emit("driver:online_ack", { ok: true, balance });
          console.log("🟢 driver online:", user.id, "| balance:", balance);
        } catch (e) {
          console.error("driver:online error", e.message);
        }
      });

      socket.on("driver:offline", async () => {
        await redisClient.del(`driver:state:${user.id}`);
        try { await redisClient.sRem("drivers:online", String(user.id)); } catch (e) {}
        try { await redisClient.sendCommand(["ZREM", "drivers:geo", String(user.id)]); } catch (e) {}
        try { await redisClient.del(`driver:loc:${user.id}`); } catch (e) {}
      });

      // تحديث موقع السائق
      socket.on("driver:location", async (data, ack) => {
        try {
          const now = Date.now();
          const last = socket.data?.lastLocTs || 0;

          if (now - last < 1000) {
            return ack && ack({ ok: true, throttled: true });
          }

          socket.data = socket.data || {};
          socket.data.lastLocTs = now;

          const { lat, lng, heading } = data;

          if (lat == null || lng == null) {
            return ack && ack({ ok: false, reason: "missing_lat_lng" });
          }

          const locObj = { lat, lng, heading: heading || null, ts: Date.now() };
          await redisService.setJSON(`driver:loc:${user.id}`, locObj, 3600);

          await redisClient.sendCommand([
            "GEOADD",
            "drivers:geo",
            String(lng),
            String(lat),
            String(user.id),
          ]);

          try {
            const reqId = await redisClient.get(`driver:busy:${user.id}`);
            if (reqId) {
              const req = await RideRequest.findByPk(reqId);
              if (req) {
                const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
                if (riderSocketId && ioInstance) {
                  ioInstance.to(riderSocketId).emit("trip:driver_location", {
                    requestId: req.id,
                    driverId: user.id,
                    lat,
                    lng,
                    heading: heading || null,
                  });
                }
              }
            }
          } catch (e) {
            console.error("emit trip:driver_location error", e.message);
          }

          return ack && ack({ ok: true });
        } catch (e) {
          console.error("driver:location error", e.message);
          return ack && ack({ ok: false, reason: e.message });
        }
      });


      // قبول طلب الرحلة من قبل السائق
      socket.on("driver:accept_request", async ({ requestId }) => {
        try {
          const driver = await User.findByPk(user.id, { attributes: ["id", "status", "walletBalance"] });
          if (!driver || driver.status === "blocked") {
            socket.emit("request:accept_failed", { reason: "driver_blocked" });
            return;
          }
          // فحص الرصيد: لا يقبل رحلة إذا محفظته فارغة
          if (Number(driver.walletBalance || 0) <= 0) {
            socket.emit("request:accept_failed", { reason: "wallet_empty", balance: Number(driver.walletBalance || 0) });
            return;
          }

          const lockKey = `order:lock:${requestId}`;
          const busy = await redisClient.get(`driver:busy:${user.id}`);
          if (busy) {
            socket.emit("request:accept_failed", { reason: "driver_busy", activeRequestId: busy });
            return;
          }
          const locked = await redisService.setLock(lockKey, String(user.id), 12);
          if (!locked) {
            socket.emit("request:accept_failed", { reason: "already_taken" });
            return;
          }

          // DB transaction
          const t = await sequelize.transaction();
          try {
            const req = await RideRequest.findByPk(requestId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!req) {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { reason: "not_found" });
              return;
            }
            if (req.status !== "pending") {
              await t.rollback();
              await redisService.releaseLock(lockKey, String(user.id));
              socket.emit("request:accept_failed", { reason: "not_pending" });
              return;
            }

            req.status = "accepted";
            req.driver_id = user.id;
            await req.save({ transaction: t });
            await t.commit();

            await redisClient.set(`driver:busy:${user.id}`, String(req.id), { EX: 60 * 60 * 3 });
            // notify rider
            const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
            const payload = { requestId: req.id, driverId: user.id };
            if (riderSocketId && ioInstance) {
              ioInstance.to(riderSocketId).emit("request:accepted", payload);
            } else {
              // offline -> send push
              try { await notifications.sendNotificationToUser(req.rider_id, 'تم قبول طلبك', 'سائق في الطريق'); } catch (e) {}
            }

            // notify other drivers to close (best-effort)
            // remove lock keeps others from accepting

            socket.emit("request:accepted", payload);
          } catch (e) {
            await t.rollback();
            await redisService.releaseLock(lockKey, String(user.id));
            socket.emit("request:accept_failed", { reason: "error", details: e.message });
          }
        } catch (e) {
          console.error("accept error", e.message);
        }
      });

      // وصول السائق
      socket.on("driver:arrived", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          req.status = "arrived";
          await req.save();
          const payload = { requestId: req.id, status: req.status };
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          if (riderSocketId && ioInstance) {
            ioInstance.to(riderSocketId).emit("trip:status_changed", payload);
          }
          try {
            await notifications.sendNotificationToUser(
              req.rider_id,
              "السائق وصل موقعك",
              "الكابتن وصل لموقعك، تقدر تطلع هسه"
            );
          } catch (e) {
            console.error("arrived push error:", e.message);
          }

        } catch (e) {
          console.error("driver:arrived error:", e.message);
        }
      });


      // بدء الرحلة
      socket.on("driver:start_trip", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          req.status = "started";
          await req.save();
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          const payload = { requestId: req.id, status: req.status };
          if (riderSocketId && ioInstance) ioInstance.to(riderSocketId).emit("trip:status_changed", payload);
        } catch (e) { console.error(e.message); }
      });

      // إنهاء الرحلة
      // يُرسل السائق: { requestId, paymentMethod: 'cash'|'online', finalFare: number }
      socket.on("driver:end_trip", async ({ requestId, paymentMethod, finalFare }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;
          if (["completed", "cancelled"].includes(req.status)) return;

          // التحقق من المدخلات
          const method = ["cash", "online"].includes(paymentMethod) ? paymentMethod : "cash";
          const fare = parseFloat(finalFare) || parseFloat(req.estimatedFare) || 0;

          // احتساب العمولة
          let commissionAmount = 0;
          try {
            const commissionTypeSetting = await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_TYPE" } });
            const commissionValueSetting = await SystemSetting.findOne({ where: { key: "DRIVER_COMMISSION_VALUE" } });
            const commissionType = commissionTypeSetting?.value || "percent";
            const commissionValue = parseFloat(commissionValueSetting?.value || 0);

            if (commissionType === "percent") {
              commissionAmount = (fare * commissionValue) / 100;
            } else {
              commissionAmount = commissionValue;
            }
          } catch (e) {
            console.error("commission calc error", e.message);
          }

          const driverEarnings = method === "online" ? fare - commissionAmount : 0;
          const commissionCents = Math.round(commissionAmount * 100);
          const earningsCents = Math.round(driverEarnings * 100);

          // تطبيق تأثير المحفظة حسب طريقة الدفع
          let walletResult = null;
          try {
            if (method === "online" && earningsCents > 0) {
              // أونلاين: نضيف صافي أرباح السائق لمحفظته
              walletResult = await applyDriverWalletTx({
                userId: req.driver_id,
                type: "credit",
                amountCents: earningsCents,
                note: `أرباح رحلة أونلاين #${req.id} (بعد خصم عمولة ${commissionAmount.toFixed(2)})`,
                metadata: { source: "ride_online", rideId: req.id, fare, commission: commissionAmount },
                rideRequestId: req.id,
              });
            } else if (method === "cash" && commissionCents > 0) {
              // كاش: نخصم نسبة الأدمن من محفظة السائق
              walletResult = await applyDriverWalletTx({
                userId: req.driver_id,
                type: "debit",
                amountCents: commissionCents,
                note: `عمولة رحلة كاش #${req.id} (من أجرة ${fare})`,
                metadata: { source: "ride_cash", rideId: req.id, fare, commission: commissionAmount },
                rideRequestId: req.id,
              });
            }
          } catch (walletErr) {
            // إذا رصيد السائق غير كافٍ للكاش - أخبره لكن أكمل الرحلة
            if (walletErr.code === "wallet_insufficient_balance") {
              console.warn(`⚠️ driver ${req.driver_id} has insufficient wallet for cash commission`);
              try {
                const sid = await redisClient.get(`socket:driver:${req.driver_id}`);
                if (sid && ioInstance) {
                  ioInstance.to(sid).emit("driver:wallet_blocked", {
                    reason: "wallet_empty",
                    message: "رصيدك صفر، يجب شحن محفظتك لاستقبال رحلات جديدة",
                    balance: 0,
                  });
                } else {
                  await notifications.sendNotificationToUser(req.driver_id, "رصيد محفظتك صفر", "يجب شحن المحفظة لاستقبال رحلات جديدة");
                }
              } catch (e) {}
            } else {
              console.error("wallet tx error on end_trip", walletErr.message);
            }
          }

          // تحديث حالة الرحلة وحقول الدفع
          req.status = "completed";
          req.paymentMethod = method;
          req.finalFare = fare.toFixed(2);
          req.adminCommission = commissionAmount.toFixed(2);
          req.driverEarnings = driverEarnings.toFixed(2);
          await req.save();
          await redisClient.del(`driver:busy:${req.driver_id}`);

          // إخبار الراكب
          const riderSocketId = await redisClient.get(`socket:rider:${req.rider_id}`);
          const payload = {
            requestId: req.id,
            status: "completed",
            paymentMethod: method,
            finalFare: fare,
          };
          if (riderSocketId && ioInstance) ioInstance.to(riderSocketId).emit("trip:status_changed", payload);

          // إخبار السائق بنتيجة المحفظة
          const driverSid = await redisClient.get(`socket:driver:${req.driver_id}`);
          const walletPayload = {
            requestId: req.id,
            paymentMethod: method,
            finalFare: fare,
            commission: commissionAmount,
            driverEarnings,
            newBalance: walletResult ? walletResult.balanceAfter : null,
          };
          if (driverSid && ioInstance) ioInstance.to(driverSid).emit("trip:completed", walletPayload);

          // تنبيه إذا رصيد السائق وصل لصفر بعد الرحلة
          if (walletResult && walletResult.balanceAfter <= 0) {
            try {
              // أخرج السائق من الأونلاين
              await redisClient.del(`driver:state:${req.driver_id}`);
              await redisClient.sRem("drivers:online", String(req.driver_id));
              await redisClient.sendCommand(["ZREM", "drivers:geo", String(req.driver_id)]);
              if (driverSid && ioInstance) {
                ioInstance.to(driverSid).emit("driver:wallet_blocked", {
                  reason: "wallet_empty",
                  message: "رصيد محفظتك وصل لصفر. يجب الشحن لاستقبال رحلات جديدة.",
                  balance: walletResult.balanceAfter,
                });
              } else {
                await notifications.sendNotificationToUser(req.driver_id, "محفظتك فارغة", "اشحن محفظتك لاستقبال رحلات جديدة");
              }
            } catch (e) {}
          }

        } catch (e) { console.error("driver:end_trip error", e.message); }
      });

      //  إنشاء طلب الرحلة من قبل الراكب
      socket.on("rider:create_request", async (data, ack) => {
        const t = await sequelize.transaction();
        try {
        const { pickup, dropoff, distanceKm, durationMin, serviceType = "normal" } = data;

          if (!pickup || !dropoff) {
            await t.rollback();
            return ack && ack({ ok: false, error: "invalid_payload" });
          }
          if (!["normal", "vip"].includes(serviceType)) {
            await t.rollback();
            return ack && ack({ ok: false, error: "invalid_service_type" });
          }
          const active = await RideRequest.findOne({
            where: {
              rider_id: user.id,
              status: { [Op.in]: ["pending", "accepted", "arrived", "started"] },
            },
            order: [["createdAt", "DESC"]],
            transaction: t,
            lock: t.LOCK.UPDATE,
          });

          if (active) {
            await t.rollback();
            console.log("⚠️ active ride exists id=", active.id, "status=", active.status);
            return ack && ack({
              ok: false,
              error: "active_ride_exists",
              message: "عندك رحلة/طلب فعال مسبقاً",
              activeRequestId: active.id,
              status: active.status,
            });
          }

          let estimatedFare = null;

          const serverKm =
            pickup?.lat != null && pickup?.lng != null && dropoff?.lat != null && dropoff?.lng != null
              ? haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng)
              : null;

          const dKm = serverKm != null ? Number(serverKm.toFixed(3)) : null;
          const dur = durationMin != null ? parseFloat(durationMin) : null;


          if (dKm != null) {
            try {
              estimatedFare = await buildEstimatedFare({
                serviceType,
                distanceKm: dKm,
                durationMin: dur,
                transaction: t,
              });
            } catch (e) {
              console.error("pricing calc error:", e.message);
            }
          } else {
            console.log("[FARE CHECK SOCKET] skipped: dKm is null");
          }

          const newReq = await RideRequest.create(
            {
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
            },
            { transaction: t }
          );

          await t.commit();

          const radiusM = 5000;
          const nearby = await redisClient
            .sendCommand([
              "GEORADIUS",
              "drivers:geo",
              String(pickup.lng),
              String(pickup.lat),
              String(radiusM),
              "m",
              "COUNT",
              "30",
              "ASC",
            ])
            
            .catch((e) => {
              console.error("❌ GEORADIUS error", e.message);
              return [];
            });

          console.log("🚕 MATCH DEBUG START");
          console.log("pickup=", pickup.lat, pickup.lng);
          console.log("radiusM=", radiusM);
          console.log("redisUrl=", process.env.REDIS_URL);

          const onlineNow = await redisClient.sMembers("drivers:online");
          console.log("drivers:online =", onlineNow);

          const geoNow = await redisClient.sendCommand(["ZRANGE", "drivers:geo", "0", "-1"]);
          console.log("drivers:geo =", geoNow);

          console.log("nearby raw =", nearby);
          
          const driverIds = (nearby || []).map(String).slice(0, 30);

          let sentCount = 0;
          const sentKey = `request:sent_to:${newReq.id}`;

          for (const did of driverIds) {
            const isOnline = await redisClient.sIsMember("drivers:online", String(did));
            const busyRideId = await redisClient.get(`driver:busy:${did}`);
            const rejectedKey = `request:rejected:${newReq.id}`;
            const isRejected = await redisClient.sIsMember(rejectedKey, String(did));
            const driverSocketId = await redisClient.get(`socket:driver:${did}`);

            console.log(`[MATCH] driver=${did} | online=${isOnline} | busy=${busyRideId} | rejected=${isRejected} | socketId=${driverSocketId}`);

            if (!isOnline) { console.log(`[MATCH] ❌ skip driver=${did}: not online`); continue; }
            if (busyRideId) { console.log(`[MATCH] ❌ skip driver=${did}: busy`); continue; }
            if (isRejected) { console.log(`[MATCH] ❌ skip driver=${did}: rejected`); continue; }

            const driver = await User.findByPk(did, {
              attributes: ["id", "role", "status", "serviceType", "walletBalance"],
            });

            if (!driver) { console.log(`[MATCH] ❌ skip driver=${did}: not found in DB`); continue; }
            if (driver.role !== "driver") { console.log(`[MATCH] ❌ skip driver=${did}: role=${driver.role}`); continue; }
            if (driver.status !== "active") { console.log(`[MATCH] ❌ skip driver=${did}: status=${driver.status}`); continue; }
            if (Number(driver.walletBalance || 0) <= 0) { console.log(`[MATCH] ❌ skip driver=${did}: wallet=${driver.walletBalance}`); continue; }

            const driverType = driver.serviceType || "normal";
            const canReceive =
              newReq.serviceType === "normal"
                ? ["normal", "vip"].includes(driverType)
                : driverType === "vip";

            if (!canReceive) { console.log(`[MATCH] ❌ skip driver=${did}: serviceType mismatch (driver=${driverType}, req=${newReq.serviceType})`); continue; }

            if (driverSocketId && ioInstance) {
              ioInstance.to(driverSocketId).emit("request:new", { request: newReq });
              sentCount++;
              await redisClient.sAdd(sentKey, String(did));
              console.log(`[MATCH] ✅ sent to driver=${did} socket=${driverSocketId}`);
            } else {
              console.log(`[MATCH] ❌ skip driver=${did}: socketId=${driverSocketId} ioInstance=${!!ioInstance}`);
            }
          }

          await redisClient.expire(sentKey, 3600);

          console.log("📤 done matching. sentCount=", sentCount);

          return ack && ack({
            ok: true,
            success: true,
            request: newReq,
            debug: { radiusM, driverIds, sentCount },
          });
        } catch (e) {
          try {
            await t.rollback();
          } catch (_) {}
          console.error("❌ rider:create_request", e.message);
          return ack && ack({ ok: false, error: e.message });
        }
      });


      // إلغاء طلب الرحلة من قبل الراكب
      socket.on("rider:cancel_request", async ({ requestId }) => {
        try {
          const req = await RideRequest.findByPk(requestId);
          if (!req) return;

          if (["completed", "cancelled"].includes(req.status)) return;

          req.status = "cancelled";
          await req.save();

          if (req.driver_id) {
            await redisClient.del(`driver:busy:${req.driver_id}`);

            const driverSid = await redisClient.get(`socket:driver:${req.driver_id}`);
            if (driverSid && ioInstance) {
              ioInstance.to(driverSid).emit("trip:status_changed", {
                requestId: req.id,
                status: "cancelled",
              });
            }
          }

          const sentKey = `request:sent_to:${req.id}`;
          const driverIds = await redisClient.sMembers(sentKey);

          for (const did of driverIds || []) {
            const sid = await redisClient.get(`socket:driver:${did}`);
            if (sid && ioInstance) {
              ioInstance.to(sid).emit("trip:status_changed", {
                requestId: req.id,
                status: "cancelled",
              });
            }
          }

          await redisClient.del(sentKey);
          await redisClient.del(`request:rejected:${req.id}`);

        } catch (e) {
          console.error("rider:cancel_request error", e.message);
        }
      });

    } catch (e) {
      console.error("socket connection error", e.message);
    }
  });
};

// اخبار السائق عبر السوكت
const notifyDriverSocket = async (driverId, event, payload) => {
  if (!ioInstance) return false;
  const redisClient = redisService.client();
  const sid = await redisClient.get(`socket:driver:${driverId}`);
  if (sid) ioInstance.to(sid).emit(event, payload);
  return !!sid;
};

// اخبار الراكب عبر السوكت
const notifyRiderSocket = async (riderId, event, payload) => {
  if (!ioInstance) return false;
  const redisClient = redisService.client();
  const sid = await redisClient.get(`socket:rider:${riderId}`);
  if (sid) ioInstance.to(sid).emit(event, payload);
  return !!sid;
};

module.exports = { init, notifyDriverSocket, notifyRiderSocket };
