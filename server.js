require('dotenv').config();
const express = require("express");
const sequelize = require("./config/db");

const usersRouter = require("./routes/user");
const notificationsRouter = require("./routes/notifications.js");
const ridesRouter = require("./routes/rides");
const adminRouter = require("./routes/admin");
const adminStatsRouter = require("./routes/adminStats");
const adminDebtRouter = require("./routes/adminDebt");

const redisService = require("./services/redis");
const socketService = require("./services/socket");
const chat = require("./routes/chatRoutes");
const cors = require("cors"); 

const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors({
  origin: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.options(/.*/, cors());
app.use(express.json());
app.use("/uploads", express.static("./uploads"));

app.use("/", usersRouter);
app.use("/", notificationsRouter);
app.use("/", ridesRouter);
app.use("/", adminRouter);
app.use("/", adminStatsRouter);
app.use("/", adminDebtRouter);
app.use("/", chat.router);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET","POST"],
    allowedHeaders: ["Content-Type","Authorization"],
  }
});

(async () => {
  try {
    await redisService.init();
    await socketService.init(io);
    const chatIO = io.of("/chat");
    chat.initChatSocket(chatIO); 
    
    await sequelize.sync({ force: false });
    console.log("✅ Database & tables synced!");

    server.listen(process.env.PORT || 1003, () => {
      console.log(`🚀 Server running on http://localhost:${process.env.PORT || 1003}`);
    });
  } catch (err) {
    console.error("❌ Startup error:", err);
    process.exit(1);
  }
})();
