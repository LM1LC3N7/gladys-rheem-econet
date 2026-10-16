# Rheem EcoNet

Your Rheem and Ruud water heaters and thermostats in Gladys, through the
EcoNet cloud (the EcoNet app, United States and Canada).

> **Never tested on a real account yet.** This first version was written from
> the open-source pyeconet library (the one of Home Assistant) and tested
> against its example answers only. Your feedback on the forum is welcome.
> Unofficial, not affiliated with Rheem.

## What you get

Each equipment of your EcoNet account is offered in the **Discovery** tab,
with the features it reports.

**Water heaters** (heat pump, electric, gas, tankless):

| Feature                  | What it is                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                     | The modes of your unit, with their EcoNet names: off, energy saver, heat pump only, high demand, electric, gas, performance, vacation. In scenes, they are the Gladys water heater modes (see the table below). |
| Water setpoint           | In °F, within the limits of the unit (often 110 to 140 °F).                                                                                                                                                     |
| Hot water available      | 0, 33, 66 or 100 %, the tank level the app shows (units that report it).                                                                                                                                        |
| Heating                  | 1 while the unit heats.                                                                                                                                                                                         |
| Shut-off valve           | Open (1) or closed (0), read only, when a valve is installed. Gladys never opens nor closes it.                                                                                                                 |
| Tank / compressor health | 0 to 100 %, when the unit reports it.                                                                                                                                                                           |
| Energy per day           | kWh used each day, from the energy report of the app (electric and heat pump units that have it). Published the next day.                                                                                       |
| Active alerts            | The number of alerts EcoNet shows for the unit (leak, fault…). Their details stay in the app.                                                                                                                   |

How the EcoNet modes become Gladys modes:

| EcoNet                     | Gladys mode |
| -------------------------- | ----------- |
| Off                        | Off         |
| Energy Saver (heat pump)   | Auto        |
| Energy Saver (other units) | Eco         |
| Heat Pump Only             | Eco         |
| High Demand, Performance   | Boost       |
| Electric, Gas              | Manual      |
| Vacation                   | Away        |

**Thermostats** (each zone of a zoned system is a device):

| Feature                    | What it is                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Temperature                | The room temperature, in °F.                                                           |
| Humidity                   | In %, when reported.                                                                   |
| Heating / cooling setpoint | In °F; in auto mode they keep the gap (deadband) the thermostat asks for.              |
| Mode                       | Off, heating, cooling, auto.                                                           |
| EcoNet mode                | Every mode of the thermostat, fan only and emergency heat included.                    |
| Running                    | Idle, heating or cooling.                                                              |
| Fan speed                  | Auto, low, medium-low, medium, medium-high, high, max (as the thermostat offers them). |
| Fan                        | Auto or on (continuous), when the thermostat has the setting.                          |
| Active alerts              | As for the water heaters.                                                              |

Temperatures stay in °F, the unit EcoNet reports (setpoints in whole
degrees, as the app sets them).

## Configuration

1. In the **Configuration** tab, enter the **e-mail address** and the
   **password** of your EcoNet app, then save.
2. Use **Test the connection**: it logs in and lists your equipments.
3. Open the **Discovery** tab and add the devices you want.

The **Language of the feature names** applies to the devices discovered
afterwards.

## How it works

- At start, the integration logs in, reads the equipment list of the account
  and opens the live link (MQTT over TLS, the one of the EcoNet app): the
  changes arrive within seconds, and the commands go through it.
- The whole account is read again every 30 minutes (every 5 minutes while
  the live link is down), and the energy of the last days every 6 hours.
- The badge of a device says **Cloud**; with an orange dot when the live link
  is down (the states are then read every 5 minutes, and the commands are
  unavailable), **Unreachable** when EcoNet reports the unit offline or cannot
  be reached.

## Limits

- Commands need the live link: while it is down, a command is refused with a
  message.
- A refused password is never retried by itself (to spare your account): fix
  it and save, or press **Test the connection** once it works again.
- Not supported yet: away/vacation scheduling, the schedule resume, water
  usage, the Wi-Fi signal, the dehumidifier setpoint, the detail of the
  alerts. The gas units do not get the energy feature (EcoNet reports kBTU).
- The water setpoint is limited by the unit only: above 120 °F, hot water can
  scald. Think about it before writing scenes.

## Privacy

Your e-mail address and password are sent to EcoNet only (HTTPS), the token
EcoNet returns stays in memory and nothing is written to disk. The password
and the token never appear in the logs.

## Troubleshooting

- "EcoNet refused the e-mail or the password": check them in the EcoNet app.
- "the live updates are down": the integration tries again (10 s, then
  longer, 5 minutes at most). The states keep coming every 5 minutes.
- A feature missing: the device is built from what the unit reported when it
  was discovered. Delete the device and scan again after a firmware update.

Rheem, Ruud and EcoNet are trademarks of their respective owners. This
integration is unofficial and not affiliated with Rheem.
