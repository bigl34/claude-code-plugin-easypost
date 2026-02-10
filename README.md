<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-easypost

Create UPS shipping labels via EasyPost API with Shopify integration

![Version](https://img.shields.io/badge/version-1.0.6-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **create-shipment** — Create shipment, get available rates (Stage 1)
- **buy-label** — Purchase label for pending shipment (Stage 2)
- **cancel-shipment** — Cancel unpurchased shipment (no charges)
- **get-shipment** — Get shipment details from EasyPost
- **list-pending** — List all pending (unpurchased) shipments
- **get-rates** — Get rates for a pending shipment
- **void-label** — Request refund for purchased label
- **list-tools** — List available commands
- **cache-stats** — Show cache statistics
- **cache-clear** — Clear all cached data

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-easypost.git
cd claude-code-plugin-easypost
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js create-shipment
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

### Available CLI Commands

| Command           | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `create-shipment` | Create shipment, get available rates (Stage 1) |
| `buy-label`       | Purchase label for pending shipment (Stage 2)  |
| `cancel-shipment` | Cancel unpurchased shipment (no charges)       |
| `get-shipment`    | Get shipment details from EasyPost             |
| `list-pending`    | List all pending (unpurchased) shipments       |
| `get-rates`       | Get rates for a pending shipment               |
| `void-label`      | Request refund for purchased label             |
| `list-tools`      | List available commands                        |
| `cache-stats`     | Show cache statistics                          |
| `cache-clear`     | Clear all cached data                          |

### create-shipment Options

| Option             | Description                                          | Required |
| ------------------ | ---------------------------------------------------- | -------- |
| `--order-id <id>`  | Shopify order ID (e.g., `gid://shopify/Order/12345`) | Yes*     |
| `--weight <kg>`    | Parcel weight in kg                                  | Yes      |
| `--length <cm>`    | Parcel length in cm                                  | No       |
| `--width <cm>`     | Parcel width in cm                                   | No       |
| `--height <cm>`    | Parcel height in cm                                  | No       |
| `--carrier <name>` | Filter rates to carrier (e.g., UPS)                  | No       |

### buy-label Options

| Option               | Description          | Required |
| -------------------- | -------------------- | -------- |
| `--shipment-id <id>` | EasyPost shipment ID | Yes      |
| `--rate-id <id>`     | Rate ID to purchase  | Yes      |

### Other Command Options

| Command           | Options              |
| ----------------- | -------------------- |
| `cancel-shipment` | `--shipment-id <id>` |
| `get-shipment`    | `--shipment-id <id>` |
| `get-rates`       | `--shipment-id <id>` |
| `void-label`      | `--shipment-id <id>` |

## Usage Examples

```bash
# 15kg package from order
node scripts/dist/cli.js create-shipment --order-id "gid://shopify/Order/12345" --weight 15

# With dimensions (for accurate rates)
node scripts/dist/cli.js create-shipment --order-id "gid://shopify/Order/12345" \
  --weight 25 --length 100 --width 50 --height 40
```

```bash
node scripts/dist/cli.js create-shipment \
  --to-name "John Smith" \
  --to-street1 "123 Main Street" \
  --to-city "London" \
  --to-zip "SW1A 1AA" \
  --to-country "GB" \
  --weight 12
```

```bash
node scripts/dist/cli.js create-shipment --order-id "gid://shopify/Order/12345" \
  --weight 15 --carrier UPS
```

```bash
node scripts/dist/cli.js list-pending
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
