# Deepal for Homey (unofficial)

Homey Pro app for **Deepal / Changan** connected cars (S05, S07, E07) through the official
international My Changan cloud. It is a Node.js port of the protocol reverse-engineered by
[ha-deepal-alternative](https://github.com/Sunek0/ha-deepal-alternative) (MIT) for Home Assistant.

> Not affiliated with Changan. Remote commands act on the real car. Use at your own risk.

## Important

- **Use a secondary account.** Logging in can sign the official app out (and the other way round).
  In the My Changan app, share the car with a second account and log in to Homey with that one.
- Lock, window and trunk commands need the **remote-control PIN** created with the account Homey
  logs in with. Enter it in the device settings; it is checked against the account when you save it.
- S05 cars report live data over MQTT only while awake. Normal polls **never wake the car**. Waking
  (the *Wake the car and refresh* Flow card, or automatically before a PIN command) is limited to
  once every 5 minutes per car to protect the 12 V battery.

## What it does

| Area | Details |
| --- | --- |
| Pairing | Email code (recommended) or SMS code login, then pick your cars. *Repair* logs in again. |
| Telemetry | Battery %, range, odometer, charging state, charge current and time remaining, lock state, climate on/off and target temperature, cabin/outside temperature, cabin humidity, doors/hood, trunk and windows open, tire pressures per wheel and a tire pressure warning. |
| Warning lights (S05) | 12 V battery, ABS, brake, brake fluid, power steering, power limit, power system, traction battery low and key fob battery. Each appears on the device the first time the car reports it; they are only read while the car is on. |
| Controls | Lock/unlock (PIN), climate on/off and target temperature. |
| Flow actions | Start climate at X °C, stop climate, flash lights, sound horn, both, open trunk (PIN), open/close windows (PIN), set charge limit, wake and refresh. |
| Flow triggers / conditions | Charging started/stopped, a dashboard warning light turned on (with the light name as a tag), is charging, is plugged in. Plus the built-in cards for every capability (battery changed, locked changed, door opened, ...). |
| Energy | Registered as an electric car (`energy.electricCar`). |

Data sources: S05 (`protocolType: MQTT`) is read over the CA MQTT broker, falling back to the REST
snapshot. Other cars use the REST condition endpoint.

## Project layout

```
app.js                      Holds the single account session (persisted in app settings)
lib/DeepalClient.js         REST: login, token refresh, vehicles, condition, signed commands, MQTT bootstrap
lib/mqtt.js                 Minimal MQTT 5 client + S05 login/condition/wake exchange
lib/crypto.js               RSA request encryption, login keypair, command signing, serial decryption, AES-CBC
lib/condition.js            Condition parsing and S05 parameter normalization
drivers/vehicle/            Driver (pairing), device (polling, commands), settings, Flow cards
drivers/vehicle/pair/login.html   Two-step email/SMS code login view
.homeycompose/              App manifest and custom capabilities (app.json is generated from these)
test/                       Offline tests (node --test)
```

No npm dependencies: everything uses Node's built-in `crypto`, `tls` and `fetch`.

## Run it on your Homey Pro

```sh
npm install -g homey
homey login
cd homey-deepal
homey app run        # runs on your Homey with live logs; Ctrl+C stops it
# or
homey app install    # installs it permanently
```

Then add a device: *Devices → + → Deepal → Deepal vehicle*.

Requires Homey Pro (2023 or later) with firmware 12.4.5 or newer.

## Tests

```sh
npm test                               # 11 offline tests, incl. a fake MQTT broker
homey app validate --level publish
```

The crypto, the S05 parsing and the MQTT topic resolution were also checked byte for byte against
the Python SDK (same key, same payload, same signature bytes).

## Status

Everything below is verified **offline only**: nothing has run against the real Changan servers or a
real car yet.

| Part | Upstream status | This port |
| --- | --- | --- |
| Email/SMS code login, token refresh | Verified live upstream | Ported, tested against a mock gateway |
| REST condition | Verified live upstream | Ported |
| S05 MQTT condition and wake | Verified live upstream | Ported, tested against a fake broker |
| Climate, lock, windows, trunk, flash/horn, charge limit commands | Verified live upstream | Ported, signature verified against the Python SDK |
| E07 `SDA-MQTT` live data | Beta upstream | **Not ported**: E07 uses the REST snapshot |
| Location, seat/steering heating, charge schedule | Available upstream | Not exposed yet |
| Latin America region | Available upstream | Selectable at login, untested |

Things to try first on a real car: pairing, a poll (check *Last report*), then flash the lights.
Run `homey app run` to see the logs.

## Credits and license

MIT. Protocol research by the
[ha-deepal-alternative](https://github.com/Sunek0/ha-deepal-alternative) contributors (MIT); see
`LICENSE`.
