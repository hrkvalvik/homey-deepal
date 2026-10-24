# Deepal for Homey: notes for Claude

Unofficial Homey Pro app (SDK 3, plain JavaScript, no npm dependencies) for Deepal / Changan
cars, built for the owner's **Deepal S05** in Norway (EU region). It is a Node.js port of the
Python SDK in [ha-deepal-alternative](https://github.com/Sunek0/ha-deepal-alternative) (MIT).
That repo's `deepal_sdk/docs/reference/intl-api.md` and `mqtt-telemetry.md` are the protocol
reference; check them before changing anything that talks to Changan.

Status: installed and working on the owner's Homey Pro (firmware 13.5.3) with the real car.
Current version **0.2.0**.

## Layout

```
app.js                        One shared account session (homey.settings 'session'), Flow card
                              registration, widget API entry points (getWidgetState, runWidgetCommand)
lib/DeepalClient.js           REST client: email/SMS code login, token refresh, vehicles, condition,
                              signed commands, MQTT bootstrap
lib/mqtt.js                   Minimal MQTT 5 over TLS + S05 login/condition/wake exchange
lib/crypto.js                 RSA request encryption, login keypair, command signing, serial
                              decryption (manual PKCS#1 v1.5 unpad: Node 20+ blocks it), AES-CBC
lib/condition.js              Condition parsing + S05 MQTT parameter normalization
drivers/vehicle/              driver.js (pairing/repair), device.js (polling, commands, widget hooks),
                              *.compose.json (capabilities, settings, Flow cards), pair/login.html
widgets/car/                  Dashboard widget: public/index.html (all UI), public/s05.png (top view),
                              api.js, widget.compose.json, preview-*.png
.homeycompose/                app.json source + custom capabilities. app.json at the root is GENERATED
                              by the Homey CLI; edit .homeycompose/ instead
test/                         node --test, offline (fake gateway, fake MQTT broker)
```

## Commands

```sh
npm test                                 # 13 offline tests
homey app validate --level publish       # must pass
homey app install                        # install on the Homey (run from macOS Terminal, see below)
homey app run --remote                   # run on Homey with live logs
```

## Things learned the hard way

- **Run the Homey CLI from macOS Terminal, not an editor's terminal.** macOS Local Network privacy
  can block Node.js in other terminals (`EHOSTUNREACH`), so the CLI falls back to Athom's cloud
  route, where `homey app install` fails with a bare `400`. Test the local route with a `fetch` of
  `https://<homey-ip-with-dashes>.homey.homeylocal.com/api/manager/system/ping?id=<homey-id>`.
- **Widget height:** Homey keeps a widget hidden until `Homey.ready()`, and a hidden page measures
  0 px. Call `Homey.ready()` without a height (manifest height is used) and send the measured
  height with `Homey.setHeight()` after it is visible. Homey caches widget height, so after a
  height bug the widget must be removed and re-added on the dashboard.
- **Never uninstall the app** to update it: that deletes the paired car, PIN, login and Flows.
  `homey app install` updates in place.
- **One login per account:** logging in can sign the official My Changan app out, so the owner uses
  a secondary account shared from the main one. The account must be registered in the My Changan
  app first (`CAC_1_1_01_024 Account not registered` otherwise), with the same sales country.
- **S05 quirks** (from upstream, keep them):
  - REST condition is a frozen snapshot for `protocolType: MQTT` cars; live data comes from the
    MQTT exchange. Normal polls never wake the car; wakes are limited to one per 5 minutes.
  - The MQTT `steeringWheelHeating` field always reads 1; steering wheel state comes only from the
    REST condition (`_overlayComfort` in device.js). Seat levels: REST wins unless older than MQTT.
  - Seat level 6 is the sleep sentinel (unknown). Warning-light bits are only trusted while the car
    is on (`powerStatusFeedBack != 0`).
  - After a confirmed command, disagreeing reports are ignored for 3 minutes (`holds` in device.js).
- Seat heating "off" must be `switch: 0` **without** a level (a 0 level is rejected).
- PIN-gated commands (lock, windows, trunk) need the 6-digit remote-control PIN in device settings.
- Widget commands answer immediately; the result arrives as the `deepal:command` realtime event,
  state as `deepal:state`.

## Open items

1. The owner's Homey runs v0.2.0 (confirmed by the owner).
2. **Driver images** are square crops of the S05 app photo (`assets/images/xlarge.png`), upscaled
   for the 1000 px size. Replace them if the owner supplies sharper square photos.
3. Possible next steps the owner was offered: When/And Flow cards for seat and steering wheel
   heating (only Then cards exist), Flow cards for range and tire pressure thresholds, charge schedule, publishing the GitHub repo (`hrkvalvik/homey-deepal`).
4. Publishing to the Homey App Store was discussed but not started. Before that: real app `id`
   (cannot change later), author, support/source URLs, README.txt. Blockers to raise with the
   owner: Deepal logo and S05 photos are Changan/Deepal's brand assets; the app uses Changan's
   private API (their app agreement, sections 10(2) and 11(1), limits use to their app).

## Style

Match the existing code: CommonJS, 2-space indent, `'use strict'`, short doc comments explaining
why, no new dependencies unless needed. Keep tests offline. The owner prefers plain explanations;
they are comfortable running commands in Terminal.
