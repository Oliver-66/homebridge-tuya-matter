"use strict";

import {
  baseIdentity,
  comparePartShape,
  getStatusValue,
  toBoolean,
  percentToMatterLevel,
  matterLevelToPercent,
  degreesToMatterHue,
  matterHueToDegrees,
  percentToMatterSat,
  matterSatToPercent,
} from "./_shared.mjs";

const MIST_MODES = ["small", "large", "interval"];

function mistToPercent(mode) {
  const idx = MIST_MODES.indexOf(String(mode ?? "").toLowerCase());
  return idx >= 0 ? Math.round(((idx + 1) / MIST_MODES.length) * 100) : 66;
}

function percentToMist(percent) {
  const idx = Math.min(
    MIST_MODES.length - 1,
    Math.max(0, Math.floor((percent / 100) * MIST_MODES.length)),
  );
  return MIST_MODES[idx];
}

function parseColorData(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* ignore */ }
  return null;
}

function readColor(device) {
  const raw = getStatusValue(device, "colour_data");
  const parsed = parseColorData(raw);
  if (!parsed) return { h: 0, s: 0, v: 100 };
  const svMax = 1000;
  return {
    h: Math.max(0, Math.min(360, Number(parsed.h ?? 0))),
    s: Math.max(0, Math.min(100, Math.round((Number(parsed.s ?? 0) / svMax) * 100))),
    v: Math.max(0, Math.min(100, Math.round((Number(parsed.v ?? svMax) / svMax) * 100))),
  };
}

function buildLedHandlers(bridge, deviceId, getLatest) {
  return {
    onOff: {
      on: async () => bridge.sendCommands(deviceId, [{ code: "switch_led", value: true }]),
      off: async () => bridge.sendCommands(deviceId, [{ code: "switch_led", value: false }]),
    },
    levelControl: {
      moveToLevel: async ({ level }) => {
        const cur = readColor(getLatest());
        const v = Math.round((matterLevelToPercent(level) / 100) * 1000);
        await bridge.sendCommands(deviceId, [
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: JSON.stringify({ h: Math.round(cur.h), s: Math.round((cur.s / 100) * 1000), v }) },
        ]);
      },
      moveToLevelWithOnOff: async ({ level }) => {
        const cur = readColor(getLatest());
        const v = Math.round((matterLevelToPercent(level) / 100) * 1000);
        await bridge.sendCommands(deviceId, [
          { code: "switch_led", value: true },
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: JSON.stringify({ h: Math.round(cur.h), s: Math.round((cur.s / 100) * 1000), v }) },
        ]);
      },
    },
    colorControl: {
      stopAllColorMovement: async () => undefined,
      moveToHueAndSaturationLogic: async ({ hue, saturation }) => {
        const cur = readColor(getLatest());
        await bridge.sendCommands(deviceId, [
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: JSON.stringify({
            h: matterHueToDegrees(hue),
            s: Math.round((matterSatToPercent(saturation) / 100) * 1000),
            v: Math.round((cur.v / 100) * 1000),
          }) },
        ]);
      },
      moveToHueLogic: async ({ targetHue }) => {
        const cur = readColor(getLatest());
        await bridge.sendCommands(deviceId, [
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: JSON.stringify({
            h: matterHueToDegrees(targetHue),
            s: Math.round((cur.s / 100) * 1000),
            v: Math.round((cur.v / 100) * 1000),
          }) },
        ]);
      },
      moveToSaturationLogic: async ({ targetSaturation }) => {
        const cur = readColor(getLatest());
        await bridge.sendCommands(deviceId, [
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: JSON.stringify({
            h: cur.h,
            s: Math.round((matterSatToPercent(targetSaturation) / 100) * 1000),
            v: Math.round((cur.v / 100) * 1000),
          }) },
        ]);
      },
    },
  };
}

export default class DiffuserMatterAccessory {
  static id = "diffuser";

  static matches(device) {
    return device?.category === "xxj";
  }

  static create(platform, bridge, device) {
    const { matter } = platform.api;
    const getLatest = () => bridge.latestDevices.get(device.id) ?? device;

    const sprayOn = toBoolean(getStatusValue(device, "switch_spray"), false);
    const mistPercent = mistToPercent(getStatusValue(device, "mode"));
    const hs = readColor(device);
    const ledOn = toBoolean(getStatusValue(device, "switch_led"), false);

    const context = { matterAccessoryType: this.id };

    return {
      ...baseIdentity(bridge, device, context),
      deviceType: matter.deviceTypes.DimmableLight,
      clusters: {
        onOff: { onOff: sprayOn },
        levelControl: { currentLevel: percentToMatterLevel(mistPercent), minLevel: 1, maxLevel: 254 },
      },
      handlers: {
        onOff: {
          on: async () => bridge.sendCommands(device.id, [{ code: "switch_spray", value: true }]),
          off: async () => bridge.sendCommands(device.id, [{ code: "switch_spray", value: false }]),
        },
        levelControl: {
          moveToLevel: async ({ level }) => {
            await bridge.sendCommands(device.id, [{ code: "mode", value: percentToMist(matterLevelToPercent(level)) }]);
          },
          moveToLevelWithOnOff: async ({ level }) => {
            await bridge.sendCommands(device.id, [
              { code: "switch_spray", value: true },
              { code: "mode", value: percentToMist(matterLevelToPercent(level)) },
            ]);
          },
        },
      },
      parts: [
        {
          id: "diffuser:led",
          displayName: "LED",
          deviceType: matter.deviceTypes.ExtendedColorLight,
          clusters: {
            onOff: { onOff: ledOn },
            levelControl: { currentLevel: percentToMatterLevel(hs.v), minLevel: 1, maxLevel: 254 },
            colorControl: {
              currentHue: degreesToMatterHue(hs.h),
              currentSaturation: percentToMatterSat(hs.s),
              colorMode: 0,
              colorCapabilities: 9,
              colorTempPhysicalMinMireds: 147,
              colorTempPhysicalMaxMireds: 454,
              coupleColorTempToLevelMinMireds: 147,
              colorTemperatureMireds: 250,
              features: { hueAndSaturation: true, enhancedHue: true, colorLoop: false, xy: false, colorTemperature: false },
            },
          },
          handlers: buildLedHandlers(bridge, device.id, getLatest),
        },
      ],
    };
  }

  static rebind(platform, bridge, accessory) {
    const deviceId = accessory.context?.deviceId;
    const getLatest = () => bridge.latestDevices.get(deviceId) ?? { status: [] };

    accessory.handlers = {
      onOff: {
        on: async () => bridge.sendCommands(deviceId, [{ code: "switch_spray", value: true }]),
        off: async () => bridge.sendCommands(deviceId, [{ code: "switch_spray", value: false }]),
      },
      levelControl: {
        moveToLevel: async ({ level }) => {
          await bridge.sendCommands(deviceId, [{ code: "mode", value: percentToMist(matterLevelToPercent(level)) }]);
        },
        moveToLevelWithOnOff: async ({ level }) => {
          await bridge.sendCommands(deviceId, [
            { code: "switch_spray", value: true },
            { code: "mode", value: percentToMist(matterLevelToPercent(level)) },
          ]);
        },
      },
    };

    if (!Array.isArray(accessory.parts)) {
      accessory.parts = [];
    }

    let ledPart = accessory.parts.find((p) => p.id === "diffuser:led");
    if (!ledPart) {
      ledPart = { id: "diffuser:led", displayName: "LED" };
      accessory.parts.push(ledPart);
    }
    ledPart.handlers = buildLedHandlers(bridge, deviceId, getLatest);
  }

  static hasDifferentShape(existing, created) {
    return comparePartShape(existing, created);
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID;
    const { matter } = platform.api;

    await bridge.safeUpdateAccessoryState(uuid, matter.clusterNames.OnOff, {
      onOff: toBoolean(getStatusValue(device, "switch_spray"), false),
    });

    await bridge.safeUpdateAccessoryState(uuid, matter.clusterNames.LevelControl, {
      currentLevel: percentToMatterLevel(mistToPercent(getStatusValue(device, "mode"))),
    });

    const ledOn = toBoolean(getStatusValue(device, "switch_led"), false);
    await bridge.safeUpdateAccessoryState(
      uuid, matter.clusterNames.OnOff, { onOff: ledOn },
      { partId: "diffuser:led" },
    );

    const hs = readColor(device);
    await bridge.safeUpdateAccessoryState(
      uuid, matter.clusterNames.LevelControl, { currentLevel: percentToMatterLevel(hs.v) },
      { partId: "diffuser:led" },
    );
    await bridge.safeUpdateAccessoryState(
      uuid, matter.clusterNames.ColorControl,
      { currentHue: degreesToMatterHue(hs.h), currentSaturation: percentToMatterSat(hs.s) },
      { partId: "diffuser:led" },
    );
  }
}
