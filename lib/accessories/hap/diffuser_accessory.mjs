"use strict";

import BaseAccessory from "./base_accessory.mjs";

const MIST_MODES = ["small", "large", "interval"];

function modeToPercent(mode) {
  const idx = MIST_MODES.indexOf(String(mode ?? "").toLowerCase());
  return idx >= 0 ? Math.round(((idx + 1) / MIST_MODES.length) * 100) : 66;
}

function percentToMode(percent) {
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

class DiffuserAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.FAN,
      Service.Fanv2,
    );

    this.statusArr = deviceConfig.status || [];

    this.spraySwitchMap = null;
    this.modeMap = null;
    this.ledSwitchMap = null;
    this.colourData = null;
    this.colourObj = { h: 0, s: 0, v: 1000 };

    // LED lightbulb as secondary service
    const { Service: Svc, Characteristic } = platform.api.hap;
    this.ledService =
      this.homebridgeAccessory.getService(Svc.Lightbulb) ||
      this.homebridgeAccessory.addService(
        Svc.Lightbulb,
        deviceConfig.name + " LED",
      );
    this.ledService.setCharacteristic(
      Characteristic.Name,
      deviceConfig.name + " LED",
    );

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.spraySwitchMap?.value ? 1 : 0))
      .onSet(async (value) => {
        await this._sendCommand("switch_spray", Boolean(value));
      });

    service
      .getCharacteristic(Characteristic.CurrentFanState)
      .onGet(() => (this.spraySwitchMap?.value
        ? Characteristic.CurrentFanState.BLOWING_AIR
        : Characteristic.CurrentFanState.INACTIVE));

    service
      .getCharacteristic(Characteristic.RotationSpeed)
      .onGet(() => modeToPercent(this.modeMap?.value))
      .onSet(async (value) => {
        await this._sendCommand("mode", percentToMode(value));
      });

    this.ledService
      .getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(this.ledSwitchMap?.value))
      .onSet(async (value) => {
        await this._sendCommand("switch_led", Boolean(value));
      });

    this.ledService
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => this.colourObj.h || 0)
      .onSet(async (value) => {
        this.colourObj.h = value;
        await this._sendColorCommand();
      });

    this.ledService
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => Math.round((this.colourObj.s / 1000) * 100))
      .onSet(async (value) => {
        this.colourObj.s = Math.round((value / 100) * 1000);
        await this._sendColorCommand();
      });
  }

  async _sendCommand(code, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
        commands: [{ code, value }],
      });
    } catch (error) {
      this.log.error(`[SET] Failed to send ${code}:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async _sendColorCommand() {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
        commands: [
          { code: "work_mode", value: "colour" },
          { code: "colour_data", value: JSON.stringify(this.colourObj) },
        ],
      });
    } catch (error) {
      this.log.error("[SET] Failed to send colour_data:", error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "switch_spray":
          this.spraySwitchMap = statusMap;
          if (isRefresh) {
            this.service
              .getCharacteristic(Characteristic.Active)
              .updateValue(statusMap.value ? 1 : 0);
            this.service
              .getCharacteristic(Characteristic.CurrentFanState)
              .updateValue(statusMap.value
                ? Characteristic.CurrentFanState.BLOWING_AIR
                : Characteristic.CurrentFanState.INACTIVE);
          }
          break;

        case "mode":
          this.modeMap = statusMap;
          if (isRefresh) {
            this.service
              .getCharacteristic(Characteristic.RotationSpeed)
              .updateValue(modeToPercent(statusMap.value));
          }
          break;

        case "switch_led":
          this.ledSwitchMap = statusMap;
          if (isRefresh) {
            this.ledService
              .getCharacteristic(Characteristic.On)
              .updateValue(Boolean(statusMap.value));
          }
          break;

        case "colour_data": {
          const parsed = parseColorData(statusMap.value);
          if (parsed) {
            this.colourData = statusMap;
            this.colourObj = {
              h: Number(parsed.h ?? 0),
              s: Number(parsed.s ?? 0),
              v: Number(parsed.v ?? 1000),
            };
            if (isRefresh) {
              this.ledService
                .getCharacteristic(Characteristic.Hue)
                .updateValue(this.colourObj.h);
              this.ledService
                .getCharacteristic(Characteristic.Saturation)
                .updateValue(Math.round((this.colourObj.s / 1000) * 100));
            }
          }
          break;
        }

        case "fault": {
          const lackWater = Number(statusMap.value) > 0;
          if (lackWater) {
            this.log.warn(`[${this.deviceConfig.name}] Lack of water detected!`);
          }
          this.service
            .getCharacteristic(Characteristic.StatusFault)
            .updateValue(lackWater
              ? Characteristic.StatusFault.GENERAL_FAULT
              : Characteristic.StatusFault.NO_FAULT);
          break;
        }
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default DiffuserAccessory;
