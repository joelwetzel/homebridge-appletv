import pyatv, { NodePyATVDevice, NodePyATVDeviceEvent, NodePyATVPowerState } from '@sebbo2002/node-pyatv';
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import NodePersist from 'node-persist';

import { AppleTVPlatform } from './platform';


/**
 * AppleTV Accessory
 */
export class AppleTVAccessory {

  private atv: NodePyATVDevice;
  private services: Service[] = [];
  private powerStateService: Service;
  private genericServices: { [property: string]: { [value: string]: Service } } = {};

  private cachedPowerState = false;

  private storage: NodePersist.LocalStorage = require('node-persist');

  constructor(
    private readonly platform: AppleTVPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.atv = pyatv.device({
      name: this.accessory.context.device.name,
      host: this.accessory.context.device.host,
      airplayCredentials: this.accessory.context.device.credentials,
      companionCredentials: this.accessory.context.device.credentials,
    });

    this.services.push(this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Apple Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'AppleTV')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.atv.id ?? 'Serial'));

    this.powerStateService = this.accessory.getService(this.platform.Service.Switch)
      || this.accessory.addService(this.platform.Service.Switch)
        .setCharacteristic(this.platform.Characteristic.Name, 'Power State');
    this.services.push(this.powerStateService);
    this.powerStateService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getCachedPowerState.bind(this));
    this.atv.on('update:powerState', async (event: NodePyATVDeviceEvent | Error) => {
      if (event instanceof Error) {
        this.platform.log.error('update:powerState error: ', event);
        return;
      }

      const newPowerState = event.newValue === NodePyATVPowerState.on;
      this.powerStateService.getCharacteristic(this.platform.Characteristic.On).updateValue(newPowerState);
      this.cachedPowerState = newPowerState;
      await this.storage.setItem('cachedPowerState', newPowerState);
      this.platform.log.info('Detected power state update from Apple TV: ' + newPowerState);
    });

    if (!this.accessory.context.device.generic_sensors) {
      this.accessory.context.device.generic_sensors = [];
    }

    if (this.accessory.context.device.device_state_sensors?.length > 0) {
      this.accessory.context.device.generic_sensors.push({
        property: 'deviceState',
        values: this.accessory.context.device.device_state_sensors,
      });
      this.platform.log.debug('generic_sensors: ', this.accessory.context.device.generic_sensors);
    }

    if (this.accessory.context.device.app_sensors?.length > 0) {
      this.accessory.context.device.generic_sensors.push({
        property: 'app',
        values: this.accessory.context.device.app_sensors,
      });
      this.platform.log.debug('generic_sensors: ', this.accessory.context.device.generic_sensors);
    }

    for (const sensor of this.accessory.context.device.generic_sensors || []) {
      const property = sensor.property;
      this.genericServices[property] = {};
      for (const value of sensor.values) {
        const name = `${property}.${value}`;
        this.genericServices[sensor.property][value] = this.accessory.getService(name)
          || this.accessory.addService(this.platform.Service.MotionSensor, name, value)
            .setCharacteristic(this.platform.Characteristic.Name, value);
        this.services.push(this.genericServices[property][value]);
      }

      this.atv.on(`update:${property}`, (event: NodePyATVDeviceEvent | Error) => {
        if (event instanceof Error) {
          return;
        }
        for (const value in this.genericServices[property]) {
          this.genericServices[property][value].setCharacteristic(this.platform.Characteristic.MotionDetected, event.newValue === value);
        }
      });
    }

    for (const service of this.accessory.services.filter(x => !this.services.includes(x))) {
      this.platform.log.info(`Removing unused service: ${service.displayName}`);
      this.accessory.removeService(service);
    }

    this.loadInitialPowerState();
  }

  /**
   * Handle "SET" requests from HomeKit
   */
  async setOn(value: CharacteristicValue) {
    if (value) {
      await this.atv.turnOn();
      this.cachedPowerState = true;
      await this.storage.setItem('cachedPowerState', true);
      this.platform.log.info('Set cachedPowerState: true');
    } else {
      await this.atv.turnOff();
      this.cachedPowerState = false;
      await this.storage.setItem('cachedPowerState', false);
      this.platform.log.info('Set cachedPowerState: false');
    }
  }

  async getCachedPowerState(): Promise<CharacteristicValue> {
    let cachedValue = await this.storage.getItem('cachedPowerState');
    if (cachedValue === undefined) {
      this.platform.log.info('Node-persist returned undefined. Using RAM cachedPowerState.');
      cachedValue = this.cachedPowerState;
    }
    this.platform.log.info('Retrieved cachedPowerState: ' + cachedValue);
    return cachedValue;
  }

  async loadInitialPowerState() {
    this.platform.log.info('Initializing node-persist...');
    await this.storage.init({
      dir: 'homebridgeAppleTv',
      stringify: JSON.stringify,
      parse: JSON.parse,
      encoding: 'utf8',
    });

    const startupPowerState = await this.getCachedPowerState();
    this.powerStateService.getCharacteristic(this.platform.Characteristic.On).updateValue(startupPowerState);
  }

}
