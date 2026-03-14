const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = "uploads";

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname).toLowerCase());
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (للفيديو)
  fileFilter: (req, file, cb) => {
    const type = String(req.body.type || "image").toLowerCase(); // image | video
    const mime = file.mimetype;

    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");

    if (!type) {
      return cb(new Error("type مطلوب (image أو video)"), false);
    }

    if (type === "image" && !isImage) {
      return cb(new Error("❌ الملف يجب أن يكون صورة"), false);
    }

    if (type === "video" && !isVideo) {
      return cb(new Error("❌ الملف يجب أن يكون فيديو"), false);
    }

    cb(null, true);
  }
});

module.exports = upload;
