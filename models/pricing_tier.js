const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const PricingTier = sequelize.define(
  "PricingTier",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serviceType: {
      type: DataTypes.ENUM("normal", "vip"),
      allowNull: false,
      defaultValue: "normal",
    },
    fromKm: { type: DataTypes.FLOAT, allowNull: false },
    toKm: { type: DataTypes.FLOAT, allowNull: true, defaultValue: null },
    pricePerKm: { type: DataTypes.FLOAT, allowNull: false },
  },
  {
    tableName: "pricing_tiers",
    timestamps: true,
    indexes: [{ fields: ["serviceType", "fromKm"] }],
  }
);

module.exports = PricingTier;
