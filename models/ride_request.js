const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const RideRequest = sequelize.define(
  "RideRequest",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    rider_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    driver_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    status: {
      type: DataTypes.ENUM("pending", "accepted", "arrived", "started", "completed", "cancelled"),
      allowNull: false,
      defaultValue: "pending",
    },
    pickupLat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    pickupLng: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    pickupAddress: { type: DataTypes.STRING, allowNull: true },
    dropoffLat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    dropoffLng: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    dropoffAddress: { type: DataTypes.STRING, allowNull: true },
    priceEstimate: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    estimatedFare: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    distanceKm: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    durationMin: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  },
  {
    timestamps: true,
    tableName: "ride_requests",
    indexes: [
      { fields: ["status"] },
      { fields: ["createdAt"] },
      { fields: ["rider_id", "createdAt"] },
      { fields: ["driver_id", "createdAt"] },
    ],
  }
);

module.exports = RideRequest;
