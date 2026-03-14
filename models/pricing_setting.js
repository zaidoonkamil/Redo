const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const PricingSetting = sequelize.define(
  "PricingSetting",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    baseFare: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    pricePerKm: { type: DataTypes.DECIMAL(10, 3), allowNull: false, defaultValue: 0 },
    pricePerMinute: { type: DataTypes.DECIMAL(10, 3), allowNull: true, defaultValue: null },
    minimumFare: { type: DataTypes.DECIMAL(10, 2), allowNull: true, defaultValue: null },
    surgeEnabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
    surgeMultiplier: { type: DataTypes.DECIMAL(4,2), allowNull: true, defaultValue: 1 },
    updatedByAdminId: { type: DataTypes.INTEGER, allowNull: true },
  },
  { timestamps: true, tableName: "pricing_settings" }
);

module.exports = PricingSetting;
