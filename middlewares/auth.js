const jwt = require("jsonwebtoken");

const authenticateToken = (req, res, next) => {
  const header = req.headers.authorization; // "Bearer xxx"
  const token = header?.startsWith("Bearer ")
    ? header.slice(7).trim()
    : header?.trim();

  if (!token) {
    return res.status(401).json({ error: "Token not provided. Unauthorized access." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err && err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    if (err) {
      return res.status(403).json({ error: "Invalid token" });
    }

    req.user = user;
    next();
  });
};

module.exports = { authenticateToken };
