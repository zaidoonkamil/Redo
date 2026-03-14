const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const UserDevice = sequelize.define("UserDevice", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    player_id: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
}, {
    timestamps: true,
    tableName: "user_devices"
});

module.exports = UserDevice;