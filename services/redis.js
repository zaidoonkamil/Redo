const { createClient } = require("redis");

let client;

const init = async () => {
  if (client) return client;
  client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (err) => console.error("Redis Client Error", err));
  await client.connect();
  return client;
};

const setJSON = async (key, value, ttlSec) => {
  await client.set(key, JSON.stringify(value), { EX: ttlSec });
};

const getJSON = async (key) => {
  const v = await client.get(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
};

const setLock = async (key, value, ttlSec) => {
  const res = await client.set(key, value, { NX: true, EX: ttlSec });
  return res === "OK";
};

const releaseLock = async (key, expectedValue) => {
  const lua = `if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;
  try {
    const res = await client.eval(lua, { keys: [key], arguments: [expectedValue] });
    return res === 1;
  } catch (e) {
    console.error("Redis releaseLock error", e.message);
    return false;
  }
};

const geoAdd = async (key, longitude, latitude, member) => {
  return client.geoAdd(key, { longitude: parseFloat(longitude), latitude: parseFloat(latitude), member: String(member) });
};

const geoRadius = async (key, longitude, latitude, radiusMeters, count = 20) => {
    try {
    const args = [key, longitude, latitude, radiusMeters, 'm', 'COUNT', count.toString(), 'ASC'];
    const res = await client.sendCommand(['GEORADIUS', ...args]);
    return res || [];
  } catch (e) {
    console.error('geoRadius error', e.message);
    return [];
  }
};

const sAdd = async (setKey, member) => {
  try { return await client.sAdd(setKey, String(member)); } catch (e) { console.error('sAdd', e.message); return 0; }
};

const sRem = async (setKey, member) => {
  try { return await client.sRem(setKey, String(member)); } catch (e) { console.error('sRem', e.message); return 0; }
};

const sMembers = async (setKey) => {
  try { return await client.sMembers(setKey); } catch (e) { console.error('sMembers', e.message); return []; }
};

module.exports = {
  init,
  client: () => client,
  setJSON,
  getJSON,
  setLock,
  releaseLock,
  geoAdd,
  geoRadius,
  sAdd,
  sRem,
  sMembers,
};
