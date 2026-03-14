const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const User = sequelize.define("User",{
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { notEmpty: true },
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: { notEmpty: true },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    role: {
      type: DataTypes.ENUM("user", "admin", "driver"),
      allowNull: false,
      defaultValue: "user",
    },
    status: {
      type: DataTypes.ENUM("active", "blocked", "pending"),
      allowNull: false,
      defaultValue: "active",
    },

    // -------------------------
    // ✅ حقول السائق (كلها اختيارية = ممكن null)
    // -------------------------
    driverImage: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    vehicleType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    vehicleColor: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    vehicleNumber: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    location: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    carImages: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    drivingLicenseFront: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    drivingLicenseBack: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },

    driverDebt: { type: DataTypes.DECIMAL(14,2), allowNull: false, defaultValue: 0 },
    driverDebtLimitOverride: { type: DataTypes.DECIMAL(14,2), allowNull: true, defaultValue: null },
    isDebtBlocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    blockReason: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
  },
  {
    timestamps: true,
    indexes: [
      { fields: ["role"] },
      { fields: ["status"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = User;
