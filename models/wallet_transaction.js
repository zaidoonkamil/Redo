const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const WalletTransaction = sequelize.define(
  "WalletTransaction",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("credit", "debit"),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    balance_before: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    balance_after: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    reference: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    note: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: "wallet_transactions",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["user_id", "createdAt"] },
      { fields: ["type"] },
      { fields: ["created_by"] },
    ],
  }
);

module.exports = WalletTransaction;
