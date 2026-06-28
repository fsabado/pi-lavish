# pi-lavish

Pi extension that bridges [Lavish Editor](https://github.com/kunchenguid/lavish-axi)
chrome conversations into the live pi session.

## Install

Add to `~/.pi/agent/settings.json` packages:

```json
{
  "source": "git:git@git-personal:fsabado/pi-lavish",
  "extensions": ["./index.ts"]
}
```

## Usage

- `/pi-lavish` — attach to most-recently opened lavish session
- `/pi-lavish <file.html>` — attach to specific artifact
- `/pi-lavish stop` — stop listening
