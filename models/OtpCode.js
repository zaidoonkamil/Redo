const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const OtpCode = sequelize.define("OtpCode", {
  id: { 
    type: DataTypes.INTEGER, 
    autoIncrement: true, 
    primaryKey: true 
  },
  phone: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },
  codeHash: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },
  purpose: { 
    type: DataTypes.ENUM("verify_account", "login"), 
    allowNull: false, 
    defaultValue: "verify_account" 
  },
  expiresAt: { type: DataTypes.DATE, allowNull: false },
  attemptsLeft: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
  consumedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
}, { timestamps: true, indexes: [{ fields: ["phone"] }, { fields: ["expiresAt"] }] });

module.exports = OtpCode;
