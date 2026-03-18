const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Op } = require("sequelize");
const { User, UserDevice, OtpCode, PasswordResetOtp, WalletTransaction } = require("../models");
const sequelize = require("../config/db");
const { authenticateToken } = require("../middlewares/auth");
const uploadImage = require("../middlewares/uploads");
const router = express.Router();
const upload = multer();
const saltRounds = 10;
const crypto = require("crypto");
const { sendWhatsAppText } = require("../services/waSender");

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const RESEND_COOLDOWN_SECONDS = 60;
const OTP_EXPIRES_MIN = 5;

function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}


router.post("/forgot-password", upload.none(), async (req, res) => {
  try {
    let { phone } = req.body;
    phone = normalizePhone(phone);

    if (!phone) return res.status(400).json({ error: "phone مطلوب" });

    const user = await User.findOne({ where: { phone } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    if (user.status === "blocked") {
      return res.status(403).json({ error: "الحساب محظور" });
    }

    const lastOtp = await PasswordResetOtp.findOne({
      where: {
        phone,
        consumedAt: null,
      },
      order: [["createdAt", "DESC"]],
    });

    if (lastOtp) {
      const secondsSinceLast = Math.floor(
        (Date.now() - new Date(lastOtp.createdAt).getTime()) / 1000
      );

      if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: `يرجى الانتظار ${
            RESEND_COOLDOWN_SECONDS - secondsSinceLast
          } ثانية قبل إعادة الإرسال`,
        });
      }

      lastOtp.consumedAt = new Date();
      await lastOtp.save();
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);

    await PasswordResetOtp.create({
      phone,
      codeHash: hashOtp(otp),
      expiresAt,
      attemptsLeft: 5,
      consumedAt: null,
    });

    const msg = `رمز إعادة تعيين كلمة المرور هو: ${otp}\nصالح لمدة ${OTP_EXPIRES_MIN} دقائق.`;
    await sendWhatsAppText(phone, msg);

    return res.status(200).json({
      message: "تم إرسال رمز إعادة تعيين كلمة المرور عبر واتساب",
    });
  } catch (err) {
    console.error("❌ forgot-password error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/reset-password", upload.none(), async (req, res) => {
  try {
    let { phone, code, newPassword } = req.body;

    phone = normalizePhone(phone);
    code = String(code || "").trim();
    newPassword = String(newPassword || "").trim();

    if (!phone || !code || !newPassword) {
      return res.status(400).json({
        error: "phone و code و newPassword مطلوبات",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "كلمة المرور قصيرة (6 أحرف على الأقل)" });
    }

    const otpRow = await PasswordResetOtp.findOne({
      where: {
        phone,
        consumedAt: null,
      },
      order: [["createdAt", "DESC"]],
    });

    if (!otpRow) return res.status(400).json({ error: "لا يوجد رمز فعال" });

    if (new Date() > new Date(otpRow.expiresAt)) {
      return res.status(400).json({ error: "انتهت صلاحية الرمز" });
    }

    if (otpRow.attemptsLeft <= 0) {
      return res.status(400).json({ error: "تم تجاوز عدد المحاولات" });
    }

    const inputHash = hashOtp(code);
    if (inputHash !== otpRow.codeHash) {
      otpRow.attemptsLeft -= 1;
      await otpRow.save();
      return res.status(400).json({ error: "رمز غير صحيح" });
    }

    otpRow.consumedAt = new Date();
    await otpRow.save();

    const user = await User.findOne({ where: { phone } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    if (user.status === "blocked") {
      return res.status(403).json({ error: "الحساب محظور" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
    user.password = hashedPassword;
    await user.save();

    const token = generateToken(user);

    return res.status(200).json({
      message: "تم تغيير كلمة المرور بنجاح",
      user: safeUser(user),
      token,
    });
  } catch (err) {
    console.error("❌ reset-password error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/verify-otp", upload.none(), async (req, res) => {
  try {
    let { phone, code } = req.body;
    phone = normalizePhone(phone);
    code = String(code || "").trim();

    if (!phone || !code) {
      return res.status(400).json({ error: "phone و code مطلوبات" });
    }

    const otpRow = await OtpCode.findOne({
      where: {
        phone,
        purpose: "verify_account",
        consumedAt: null,
      },
      order: [["createdAt", "DESC"]],
    });

    if (!otpRow) return res.status(400).json({ error: "لا يوجد رمز فعال" });

    if (new Date() > new Date(otpRow.expiresAt)) {
      return res.status(400).json({ error: "انتهت صلاحية الرمز" });
    }

    if (otpRow.attemptsLeft <= 0) {
      return res.status(400).json({ error: "تم تجاوز عدد المحاولات" });
    }

    const inputHash = hashOtp(code);
    if (inputHash !== otpRow.codeHash) {
      otpRow.attemptsLeft -= 1;
      await otpRow.save();
      return res.status(400).json({ error: "رمز غير صحيح" });
    }

    otpRow.consumedAt = new Date();
    await otpRow.save();

    const user = await User.findOne({ where: { phone, role: "user" } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    user.status = "active";
    await user.save();

    const token = generateToken(user);

    return res.status(200).json({
      message: "تم توثيق الحساب بنجاح",
      user: safeUser(user),
      token,
    });
  } catch (err) {
    console.error("❌ verify-otp error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/resend-otp", async (req, res) => {
  try {
    let { phone } = req.body;
    phone = normalizePhone(phone);

    if (!phone) return res.status(400).json({ error: "phone مطلوب" });

    const user = await User.findOne({ where: { phone, role: "user" } });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    if (user.status === "active") {
      return res.status(400).json({ error: "الحساب موثق مسبقًا" });
    }
    if (user.status === "blocked") {
      return res.status(403).json({ error: "الحساب محظور" });
    }

    const lastOtp = await OtpCode.findOne({
      where: {
        phone,
        purpose: "verify_account",
        consumedAt: null,
      },
      order: [["createdAt", "DESC"]],
    });

    if (lastOtp) {
      const secondsSinceLast = Math.floor((Date.now() - new Date(lastOtp.createdAt).getTime()) / 1000);
      if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: `يرجى الانتظار ${RESEND_COOLDOWN_SECONDS - secondsSinceLast} ثانية قبل إعادة الإرسال`,
        });
      }

      lastOtp.consumedAt = new Date();
      await lastOtp.save();
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);

    await OtpCode.create({
      phone,
      codeHash: hashOtp(otp),
      purpose: "verify_account",
      expiresAt,
      attemptsLeft: 5,
      consumedAt: null,
    });

    const msg = `رمز التحقق الخاص بك هو: ${otp}\nصالح لمدة ${OTP_EXPIRES_MIN} دقائق.`;
    await sendWhatsAppText(phone, msg);

    return res.status(200).json({ message: "تم إعادة إرسال رمز التحقق عبر واتساب" });
  } catch (err) {
    console.error("❌ resend-otp error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

const normalizePhone = (phone = "") => {
  phone = String(phone).trim();
  if (phone.startsWith("0")) return "964" + phone.slice(1);
  return phone;
};

const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "700d" }
  );
};

const requireAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Token is missing" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const admin = await User.findByPk(decoded.id);
    if (!admin) return res.status(401).json({ error: "User not found" });

    if (admin.role !== "admin") {
      return res.status(403).json({ error: "Not allowed" });
    }

    req.user = admin;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const safeUser = (user) => {
  const u = user.toJSON();
  delete u.password;
  return u;
};

const parsePositiveAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(2));
};

const applyWalletChange = async ({ userId, type, amount, createdBy, note, reference, metadata }) => {
  return sequelize.transaction(async (t) => {
    const user = await User.findByPk(userId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }

    const before = Number(user.walletBalance || 0);
    let after = before;

    if (type === "credit") {
      after = before + amount;
    } else if (type === "debit") {
      if (before < amount) {
        throw new Error("INSUFFICIENT_BALANCE");
      }
      after = before - amount;
    } else {
      throw new Error("INVALID_WALLET_TYPE");
    }

    user.walletBalance = Number(after.toFixed(2));
    await user.save({ transaction: t });

    const movement = await WalletTransaction.create(
      {
        user_id: user.id,
        type,
        amount,
        balance_before: Number(before.toFixed(2)),
        balance_after: Number(after.toFixed(2)),
        note: note || null,
        reference: reference || null,
        metadata: metadata || null,
        created_by: createdBy || null,
      },
      { transaction: t }
    );

    return {
      user,
      movement,
    };
  });
};

router.post("/users", upload.none(), async (req, res) => {
  try {
    const { name, password, role = "user", status } = req.body;
    let { phone } = req.body;

    phone = normalizePhone(phone);

    if (!name || !phone || !password) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة: الاسم, رقم الهاتف, كلمة المرور" });
    }

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "role مسموح فقط: user أو admin" });
    }

    if (status && !["active", "blocked", "pending"].includes(status)) {
      return res.status(400).json({ error: "status غير صحيح" });
    }

    const existingPhone = await User.findOne({ where: { phone } });
    if (existingPhone) {
      return res.status(400).json({ error: "تم استخدام رقم الهاتف من مستخدم اخر" });
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = await User.create({
      name,
      phone,
      password: hashedPassword,
      role,
      status: status || "active",
    });

    const token = generateToken(user);

    return res.status(201).json({
      message: "تم إنشاء الحساب بنجاح",
      user: safeUser(user),
      token,
    });
  } catch (err) {
    console.error("❌ Error creating user:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/drivers/register",
  uploadImage.fields([
    { name: "driverImage", maxCount: 1 },
    { name: "carImages", maxCount: 10 },     
    { name: "drivingLicenseFront", maxCount: 1 }, 
    { name: "drivingLicenseBack", maxCount: 1 }, 
  ]),
  async (req, res) => {
    try {
      const {
        name,
        password,
        vehicleType,
        vehicleColor,
        vehicleNumber,
        location,
        status,
        serviceType,
      } = req.body;

      let { phone } = req.body;
      phone = normalizePhone(phone);

      if (status && !["active", "blocked", "pending"].includes(status)) {
        return res.status(400).json({
          error: "status غير صحيح (active | blocked | pending)",
        });
      }

      if (serviceType && !["normal", "vip"].includes(serviceType)) {
        return res.status(400).json({
          error: "serviceType غير صحيح (normal | vip)",
        });
      }

      if (!name || !phone || !password) {
        return res.status(400).json({ error: "جميع الحقول مطلوبة: name, phone, password" });
      }

      if (!vehicleType || !vehicleColor || !vehicleNumber) {
        return res.status(400).json({
          error: "حقول السائق مطلوبة: نوع السيارة, لون السيارة, رقم السيارة",
        });
      }

      const locationText = String(location || "").trim();
      if (!locationText) {
        return res.status(400).json({
          error: "الموقع مطلوب كنص مثال: بغداد الاعضمية قرب محطة البانزين خانة",
        });
      }

      const driverImg = req.files?.driverImage?.[0]?.filename;

      const carImgs =
        Array.isArray(req.files?.carImages) ? req.files.carImages.map((f) => f.filename) : [];

      const licFront = req.files?.drivingLicenseFront?.[0]?.filename;
      const licBack = req.files?.drivingLicenseBack?.[0]?.filename;

      if (!driverImg) {
        return res.status(400).json({ error: "صورة السائق مطلوبة" });
      }
      if (!carImgs.length) {
        return res.status(400).json({ error: "لازم ترفع على الأقل صورة واحدة للسيارة" });
      }
      if (!licFront || !licBack) {
        return res.status(400).json({
          error: "صور اجازة السوق مطلوبة: drivingLicenseFront, drivingLicenseBack",
        });
      }

      const existingPhone = await User.findOne({ where: { phone } });
      if (existingPhone) {
        return res.status(400).json({ error: "تم استخدام رقم الهاتف من مستخدم اخر" });
      }

      const hashedPassword = await bcrypt.hash(password, saltRounds);

      const driver = await User.create({
        name,
        phone,
        password: hashedPassword,
        role: "driver",
        status: status || "pending",
        serviceType: serviceType || "normal",
        driverImage: { main: driverImg },
        carImages: { main: carImgs[0], images: carImgs },
        vehicleType,
        vehicleColor,
        vehicleNumber,
        location: locationText,
        drivingLicenseFront: { main: licFront },
        drivingLicenseBack: { main: licBack },
      });

      const token = generateToken(driver);
      return res.status(201).json({
        message: "تم تسجيل السائق بنجاح (بانتظار تفعيل الأدمن)",
        user: safeUser(driver),
        token,
      });
    } catch (err) {
      console.error("❌ Error creating driver:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

router.post("/login", upload.none(), async (req, res) => {
  try {
    let { phone } = req.body;
    const { password } = req.body;

    phone = normalizePhone(phone);

    if (!phone || !password) {
      return res.status(400).json({ error: "يرجى إدخال رقم الهاتف وكلمة المرور" });
    }

    const user = await User.findOne({ where: { phone } });
    if (!user) {
      return res.status(400).json({ error: "يرجى إدخال رقم الهاتف بشكل صحيح" });
    }

    if (user.role === "user" && user.status === "pending") {
      return res.status(403).json({ error: "الحساب غير موثق. يرجى إدخال رمز التحقق." });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ error: "الحساب محظور" });
    }

    if (user.role === "driver" && user.status === "pending") {
      return res.status(403).json({ error: "حساب السائق بانتظار التفعيل" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
    }

    const token = generateToken(user);

    return res.status(200).json({
      message: "Login successful",
      user: safeUser(user),
      token,
    });
  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل الدخول:", err);
    return res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.get("/usersOnly", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: users } = await User.findAndCountAll({
      where: { role: { [Op.notIn]: ["admin","driver"] } },
      limit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      users,
      pagination: {
        totalUsers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/driversOnly", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: drivers } = await User.findAndCountAll({
      where: { role: "driver" },
      limit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      drivers,
      pagination: {
        totalDrivers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching drivers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/driversOnly/search", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const search = req.query.q || "";

    const { count, rows: drivers } = await User.findAndCountAll({
      where: {
        role: "driver",
        [Op.or]: [
          { name: { [Op.like]: `%${search}%` } },
          { phone: { [Op.like]: `%${search}%` } },
        ],
      },
      limit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      drivers,
      pagination: {
        totalDrivers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error searching drivers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/adminOnly", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: users } = await User.findAndCountAll({
      where: { role: "admin" },
      limit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      users,
      pagination: {
        totalDrivers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching drivers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/user/:id", async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ["password"] },
    });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
    return res.status(200).json(user);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/profile", async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "Token is missing" });

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });

    try {
      const user = await User.findByPk(decoded.id, {
        attributes: { exclude: ["password"] },
      });

      if (!user) return res.status(404).json({ error: "User not found" });

      return res.status(200).json(user);
    } catch (error) {
      console.error("❌ Error fetching user profile:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  });
});

router.delete("/users/:id", async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      include: { model: UserDevice, as: "devices" },
    });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    await user.destroy();
    return res.status(200).json({ message: "تم حذف المستخدم وأجهزته بنجاح" });
  } catch (err) {
    console.error("❌ خطأ أثناء الحذف:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء عملية الحذف" });
  }
});

router.get("/drivers/pending", requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const offset = (page - 1) * limit;

    const { count, rows: drivers } = await User.findAndCountAll({
      where: { role: "driver", status: "pending" },
      limit,
      offset,
      order: [["createdAt", "ASC"]],
      attributes: { exclude: ["password"] },
    });

    return res.status(200).json({
      drivers,
      pagination: {
        totalDrivers: count,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching pending drivers:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/drivers/:id/activate", requireAdmin, async (req, res) => {
  try {
    const driverId = Number(req.params.id);

    const driver = await User.findByPk(driverId);
    if (!driver) return res.status(404).json({ error: "السائق غير موجود" });

    if (driver.role !== "driver") {
      return res.status(400).json({ error: "هذا المستخدم ليس سائق" });
    }

    if (driver.status === "active") {
      return res.status(200).json({ message: "السائق مفعل مسبقًا", driver: safeUser(driver) });
    }

    driver.status = "active";
    await driver.save();

    return res.status(200).json({
      message: "تم تفعيل السائق بنجاح",
      driver: safeUser(driver),
    });
  } catch (err) {
    console.error("❌ Error activating driver:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/users/:id/status", requireAdmin, upload.none(), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { status } = req.body;
    if (!["active", "blocked", "pending"].includes(status)) {
      return res.status(400).json({ error: "status غير صحيح (active | blocked | pending)" });
    }
    const target = await User.findByPk(userId);
    if (!target) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (target.role === "admin") {
      return res.status(403).json({ error: "لا يمكن تغيير حالة الأدمن" });
    }
    if (req.user && req.user.id === target.id) {
      return res.status(403).json({ error: "لا يمكنك تغيير حالتك أنت" });
    }
    target.status = status;
    await target.save();
    return res.status(200).json({
      message: "تم تحديث حالة المستخدم بنجاح",
      user: safeUser(target),
    });
  } catch (err) {
    console.error("❌ Error updating user status:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// يعرض رصيد المحفظة الحالي للمستخدم
router.get("/wallet", authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ["id", "name", "phone", "walletBalance"],
    });

    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    return res.status(200).json({
      wallet: {
        userId: user.id,
        balance: Number(user.walletBalance || 0),
      },
    });
  } catch (err) {
    console.error("❌ Error fetching wallet:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// يعرض سجل حركات المحفظة للمستخدم
router.get("/wallet/transactions", authenticateToken, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const offset = (page - 1) * limit;

    const { count, rows } = await WalletTransaction.findAndCountAll({
      where: { user_id: req.user.id },
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    return res.status(200).json({
      transactions: rows,
      pagination: {
        total: count,
        page,
        totalPages: Math.ceil(count / limit),
        limit,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching wallet transactions:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// شحن المحفظة للمستخدم (للاستخدام من قبل الأدمن)
router.post("/admin/wallet/topup", requireAdmin, upload.none(), async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const amount = parsePositiveAmount(req.body.amount);
    const note = String(req.body.note || "").trim();
    const reference = String(req.body.reference || "").trim();

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "userId غير صحيح" });
    }

    if (!amount) {
      return res.status(400).json({ error: "amount يجب أن يكون رقمًا أكبر من 0" });
    }

    const { user, movement } = await applyWalletChange({
      userId,
      type: "credit",
      amount,
      createdBy: req.user.id,
      note,
      reference,
      metadata: { source: "admin_topup" },
    });

    return res.status(200).json({
      message: "تم شحن المحفظة بنجاح",
      wallet: {
        userId: user.id,
        balance: Number(user.walletBalance || 0),
      },
      transaction: movement,
    });
  } catch (err) {
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }
    console.error("❌ Error topping up wallet:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// خصم رصيد من المحفظة للمستخدم (للاستخدام من قبل الأدمن)
router.post("/admin/wallet/deduct", requireAdmin, upload.none(), async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const amount = parsePositiveAmount(req.body.amount);
    const note = String(req.body.note || "").trim();
    const reference = String(req.body.reference || "").trim();

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "userId غير صحيح" });
    }

    if (!amount) {
      return res.status(400).json({ error: "amount يجب أن يكون رقمًا أكبر من 0" });
    }

    const { user, movement } = await applyWalletChange({
      userId,
      type: "debit",
      amount,
      createdBy: req.user.id,
      note,
      reference,
      metadata: { source: "admin_deduct" },
    });

    return res.status(200).json({
      message: "تم خصم الرصيد من المحفظة بنجاح",
      wallet: {
        userId: user.id,
        balance: Number(user.walletBalance || 0),
      },
      transaction: movement,
    });
  } catch (err) {
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }
    if (err.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({ error: "رصيد المحفظة غير كافٍ" });
    }
    console.error("❌ Error deducting wallet:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


module.exports = router;