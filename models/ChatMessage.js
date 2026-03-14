const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const ChatMessage = sequelize.define("ChatMessage", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    senderId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    receiverId: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    read: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    }
}, {
    timestamps: true
});

ChatMessage.associate = (models) => {
    ChatMessage.belongsTo(models.User, { as: "sender", foreignKey: "senderId" });
    ChatMessage.belongsTo(models.User, { as: "receiver", foreignKey: "receiverId" });
};

module.exports = ChatMessage;
