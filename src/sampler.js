'use strict';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 };
const UINT32_RANGE = 0x100000000;

function hashString(value) {
  let hash = 0x811c9dc5;
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeMessage(message) {
  return String(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+/g, '<num>');
}

function freshWindowStats() {
  return { arrivals: 0, kept: 0, dropped: 0, reasons: Object.create(null) };
}

class LogSampler {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 1000;
    this.serviceBudget = options.serviceBudget ?? 100;
    this.globalBudget = options.globalBudget ?? 1000;
    this.errorKeepProbability = options.errorKeepProbability ?? 1;
    this.firstErrorKeepProbability = options.firstErrorKeepProbability ?? 1;
    this.duplicateKeepEvery = Math.max(1, options.duplicateKeepEvery ?? 10);
    this.traceTtlMs = options.traceTtlMs ?? this.windowMs * 10;
    this.maxTraces = options.maxTraces ?? 10000;
    this.maxFingerprints = options.maxFingerprints ?? 10000;
    this._random = options.random ?? Math.random;
    this._now = options.now ?? (() => Date.now());

    this._windowIndex = Math.floor(this._now() / this.windowMs);
    this._windowStart = this._windowIndex * this.windowMs;
    this._services = new Map();
    this._global = freshWindowStats();
    this._fingerprints = new Map();
    this._traces = new Map();
    this._errorFingerprints = new Map();
  }

  setBudgets({ serviceBudget, globalBudget } = {}) {
    if (serviceBudget != null) this.serviceBudget = serviceBudget;
    if (globalBudget != null) this.globalBudget = globalBudget;
  }

  decide({ serviceId, level = 'INFO', traceId = null, message = '' } = {}) {
    if (serviceId == null) throw new TypeError('serviceId is required');
    const now = this._now();
    this._advanceWindow(now);

    const svc = this._serviceStats(serviceId);
    svc.arrivals += 1;
    this._global.arrivals += 1;

    const levelName = String(level).toUpperCase();
    const severity = LEVELS[levelName] ?? LEVELS.INFO;
    const isError = severity >= LEVELS.ERROR;
    const fingerprint = hashString(`${serviceId}|${levelName}|${normalizeMessage(message)}`);
    const seenCount = (this._fingerprints.get(fingerprint) ?? 0) + 1;
    this._fingerprints.set(fingerprint, seenCount);

    if (traceId != null) {
      const cached = this._traces.get(traceId);
      if (cached && cached.expiresAt > now) {
        cached.expiresAt = now + this.traceTtlMs;
        return this._finish(svc, cached.keep, 'trace-consistent', this._adaptiveRate(svc, now));
      }
    }

    let keep;
    let reason;
    if (isError) {
      if (!this._errorFingerprints.has(fingerprint)) {
        this._rememberErrorFingerprint(fingerprint);
        keep = this._random() < this.firstErrorKeepProbability;
        reason = 'first-error';
      } else {
        keep = this._random() < this.errorKeepProbability;
        reason = 'error';
      }
    } else if (seenCount > 1) {
      keep = seenCount % this.duplicateKeepEvery === 0;
      reason = 'duplicate';
    } else {
      const rate = this._adaptiveRate(svc, now);
      keep = traceId != null
        ? hashString(`trace:${traceId}`) / UINT32_RANGE < rate
        : this._random() < rate;
      reason = keep ? 'sampled' : 'rate-limited';
    }

    if (keep && !isError) {
      if (svc.kept >= this.serviceBudget) {
        keep = false;
        reason = 'service-budget-exhausted';
      } else if (this._global.kept >= this.globalBudget) {
        keep = false;
        reason = 'global-budget-exhausted';
      }
    }

    if (traceId != null) {
      this._traces.set(traceId, { keep, expiresAt: now + this.traceTtlMs });
      this._evictTraces();
    }

    return this._finish(svc, keep, reason, this._adaptiveRate(svc, now));
  }

  stats() {
    this._advanceWindow(this._now());
    const services = {};
    for (const [id, svc] of this._services) {
      services[id] = {
        arrivals: svc.arrivals,
        kept: svc.kept,
        dropped: svc.dropped,
        sampleRate: svc.arrivals === 0 ? 0 : svc.kept / svc.arrivals,
        reasons: { ...svc.reasons },
      };
    }
    return {
      windowStart: this._windowStart,
      windowMs: this.windowMs,
      serviceBudget: this.serviceBudget,
      globalBudget: this.globalBudget,
      global: {
        arrivals: this._global.arrivals,
        kept: this._global.kept,
        dropped: this._global.dropped,
        sampleRate: this._global.arrivals === 0 ? 0 : this._global.kept / this._global.arrivals,
        reasons: { ...this._global.reasons },
      },
      services,
    };
  }

  _serviceStats(serviceId) {
    let svc = this._services.get(serviceId);
    if (!svc) {
      svc = freshWindowStats();
      this._services.set(serviceId, svc);
    }
    return svc;
  }

  _finish(svc, keep, reason, sampleRate) {
    if (keep) {
      svc.kept += 1;
      this._global.kept += 1;
    } else {
      svc.dropped += 1;
      this._global.dropped += 1;
    }
    svc.reasons[reason] = (svc.reasons[reason] ?? 0) + 1;
    this._global.reasons[reason] = (this._global.reasons[reason] ?? 0) + 1;
    return { keep, reason, sampleRate };
  }

  _adaptiveRate(svc, now) {
    const elapsed = Math.max(now - this._windowStart, 0);
    const fraction = Math.min(1, Math.max(elapsed / this.windowMs, 0.05));
    const projected = svc.arrivals / fraction;
    if (projected <= this.serviceBudget) return 1;
    return Math.max(0, Math.min(1, this.serviceBudget / projected));
  }

  _advanceWindow(now) {
    const index = Math.floor(now / this.windowMs);
    if (index === this._windowIndex) return;
    this._windowIndex = index;
    this._windowStart = index * this.windowMs;
    this._services.clear();
    this._global = freshWindowStats();
    this._fingerprints.clear();
  }

  _rememberErrorFingerprint(fingerprint) {
    this._errorFingerprints.set(fingerprint, true);
    if (this._errorFingerprints.size <= this.maxFingerprints) return;
    const oldest = this._errorFingerprints.keys().next();
    while (!oldest.done && this._errorFingerprints.size > this.maxFingerprints / 2) {
      this._errorFingerprints.delete(oldest.value);
      oldest = this._errorFingerprints.keys().next();
    }
  }

  _evictTraces() {
    if (this._traces.size <= this.maxTraces) return;
    for (const traceId of this._traces.keys()) {
      if (this._traces.size <= this.maxTraces / 2) break;
      this._traces.delete(traceId);
    }
  }
}

module.exports = { LogSampler, LEVELS, hashString, normalizeMessage };
