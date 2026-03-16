const { PricingSetting, PricingTier } = require("../models");

const DEFAULT_PRICING = {
  normal: {
    baseFare: 2000,
    pricePerKm: 500,
    pricePerMinute: 0,
    minimumFare: 3000,
  },
  vip: {
    baseFare: 4000,
    pricePerKm: 1000,
    pricePerMinute: 0,
    minimumFare: 5000,
  },
};

const parseAmount = (value, fallback) => {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
};

const parseDistance = (value) => {
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
};

const parseDuration = (value) => {
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
};

const roundFareToNearest250 = (amount) => {
  const num = parseFloat(amount);
  if (!Number.isFinite(num)) return null;
  return Math.round(num / 250) * 250;
};

const calculateTierFare = (distanceKm, tiers) => {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  if (!Array.isArray(tiers) || !tiers.length) return null;
  if (distanceKm === 0) return 0;

  let total = 0;

  for (const tier of tiers) {
    const start = parseFloat(tier.fromKm);
    const end = tier.toKm == null ? null : parseFloat(tier.toKm);
    const rate = parseFloat(tier.pricePerKm);

    if (!Number.isFinite(start) || (!Number.isFinite(end) && end !== null) || !Number.isFinite(rate)) {
      return null;
    }

    if (distanceKm <= start) break;

    const upperBound = end == null ? distanceKm : Math.min(distanceKm, end);
    const covered = Math.max(0, upperBound - start);

    if (covered <= 0) continue;

    total += covered * rate;

    if (end == null || distanceKm <= end) break;
  }

  return Number.isFinite(total) ? total : null;
};

const applyFinalAdjustments = (amount, minimumFare) => {
  const beforeRound = Math.max(minimumFare, amount);
  const rounded = roundFareToNearest250(beforeRound);
  return rounded != null ? String(rounded) : null;
};

const fallbackFare = (defaults, distance, duration) => {
  const total =
    defaults.baseFare +
    distance * defaults.pricePerKm +
    duration * defaults.pricePerMinute;
  return applyFinalAdjustments(total, defaults.minimumFare);
};

const buildEstimatedFare = async ({ serviceType = "normal", distanceKm, durationMin, transaction } = {}) => {
  const distance = parseDistance(distanceKm);
  if (distance === null) return null;
  const duration = parseDuration(durationMin);

  const defaults = DEFAULT_PRICING[serviceType] || DEFAULT_PRICING.normal;

  try {
    const pricing = await PricingSetting.findOne({
      where: { serviceType },
      order: [["createdAt", "DESC"]],
      transaction,
    });

    const baseFare = parseAmount(pricing?.baseFare, defaults.baseFare);
    const perKmFallback = parseAmount(pricing?.pricePerKm, defaults.pricePerKm);
    const perMinute = parseAmount(pricing?.pricePerMinute, defaults.pricePerMinute);
    const minimumFare = parseAmount(pricing?.minimumFare, defaults.minimumFare);

    const tiers = await PricingTier.findAll({
      where: { serviceType },
      order: [["fromKm", "ASC"]],
      transaction,
    });

    let distanceFare = null;
    if (tiers.length) {
      const normalized = tiers.map((tier) => ({
        fromKm: parseFloat(tier.fromKm),
        toKm: tier.toKm == null ? null : parseFloat(tier.toKm),
        pricePerKm: parseFloat(tier.pricePerKm),
      }));
      const tierFare = calculateTierFare(distance, normalized);
      if (tierFare != null) {
        distanceFare = tierFare;
      }
    }

    if (distanceFare == null) {
      distanceFare = distance * perKmFallback;
    }

    let total = baseFare + distanceFare + duration * perMinute;

    if (pricing?.surgeEnabled) {
      const surgeMultiplier = parseAmount(pricing?.surgeMultiplier, 1);
      if (surgeMultiplier && surgeMultiplier > 0) {
        total *= surgeMultiplier;
      }
    }

    return applyFinalAdjustments(total, minimumFare);
  } catch (err) {
    console.error("[fareCalculator] buildEstimatedFare error", err.message);
    return fallbackFare(defaults, distance, duration);
  }
};

module.exports = {
  DEFAULT_PRICING,
  roundFareToNearest250,
  calculateTierFare,
  buildEstimatedFare,
};
