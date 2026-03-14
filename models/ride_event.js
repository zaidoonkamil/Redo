const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

// Optional lightweight events table. Keep minimal to avoid RAM/DB bloat.
const RideEvent = sequelize.define(
  "RideEvent",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ride_request_id: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    meta: { type: DataTypes.JSON, allowNull: true },
  },
  {
    timestamps: true,
    tableName: "ride_events",
  }
);

module.exports = RideEvent;
