# ha-comparison-card

A Home Assistant Lovelace card that compares a date range of this year with the same range of
previous years.

- The current year is drawn as **stacked bars** from long-term statistics.
- Previous years stand behind it as **ghost bars**: the same segments in the same colors,
  translucent and offset, each year one step further back.
- A **value table** lists the totals per year with the change against the current year.
- **Calculated rows** add your own figures (consumption, self-sufficiency, costs, …) from Jinja2
  templates.

One JavaScript file, no dependencies, with a visual editor.

| Light | Dark |
|---|---|
| ![Energy, light theme](images/energy-light.png) | ![Energy, dark theme](images/energy-dark.png) |
| ![Rain, light theme](images/rain-light.png) | ![Rain, dark theme](images/rain-dark.png) |

*Screenshots with invented data. The configurations are the first two [examples](#examples).*

## Features

- One bar per **hour, day or month** over any date range, also across New Year (e.g. a heating
  season from October to March).
- **Every year over the same range:** calendar days line up across years. With a rolling end
  (yesterday or today) previous years stop at the same calendar day; with a fixed last day every
  previous year counts its whole range. Leap days only count where they exist.
- **Several statistics per series** are summed up, e.g. three inverters as one "Solar" series.
  Statistics are used directly, so a replaced or deleted device keeps its history.
- Up to **five previous years**, opacity per year. Chips in the card show or hide single years.
- **Missing data** is detected per day. Years with gaps are marked with `*` and get no percentage.
- Tooltip per bar, theme colors, number and date format of your Home Assistant language.

## Installation

1. Copy `ha-comparison-card.js` to `/config/www/ha-comparison-card/`.
2. Add it as a dashboard resource (*Settings → Dashboards → ⋮ → Resources*):
   URL `/local/ha-comparison-card/ha-comparison-card.js`, type *JavaScript module*.
3. Reload the browser and add the card *Comparison Card* to a dashboard.

## Configuration

| Key | Default | Description |
|---|---|---|
| `title` | – | Card title |
| `start` | `01-01` | First day of the range (`MM-DD`) |
| `end` | yesterday | Last day: `MM-DD`, `yesterday` or `today` (see [Date range](#date-range)) |
| `group_by` | `month` | One bar per `hour`, `day` or `month` |
| `compare_years` | `[1]` | Previous years as years back (1 = last year, up to 5) |
| `ghost_opacity` | 45, 30, 20, 13, 8 % | Opacity per years back, e.g. `{1: 50, 2: 25}` (percent, or fractions up to 1) |
| `series` | – | Bars and table lines, see [Series](#series) |
| `rows` | – | Calculated rows, see [Calculated rows](#calculated-rows) |
| `headline` | – | Name of a series or row shown large in the header, with the change against the first compared year |
| `show_table` | `true` | Show the value table |
| `stat_type` | `auto` | `change` (meters), `mean`, `min` or `max`. Auto: `change` for statistics with a sum, `mean` otherwise |
| `unit` | from statistic | Display unit; converts within the unit class (Wh/kWh/MWh, …) |
| `decimals` | automatic | Decimals of the series values |
| `chart_height` | `200` | Chart height in px |

### Series

The order of the series is the stacking order from the zero line and the order of the table lines.

| Key | Description |
|---|---|
| `name` | Label in the table and tooltip |
| `statistics` | One or more statistic IDs (entity IDs or external statistics); their values are summed up |
| `id` | Template variable name. Default: derived from the name (`Grid import` → `grid_import`; `ä` → `ae`, `é` → `e`) |
| `color` | Any CSS color; default from a fixed palette |
| `below_zero` | Draw this series below the zero line, e.g. feed-in. Display only, nothing is subtracted |

### Calculated rows

| Key | Description |
|---|---|
| `name` | Label |
| `icon` | Icon in front of the label, default `mdi:function-variant` |
| `template` | Jinja2 template, rendered once per year |
| `unit` | Unit shown after the value (default: unit of the statistics) |
| `decimals` | Decimals |

## Date range

| `end` | Range | Today |
|---|---|---|
| empty / `yesterday` | first day … yesterday, moves on every day | not included (whole days only) |
| `today` | first day … today, moves on every day | included, refreshed every 10 minutes |
| `MM-DD` | fixed, e.g. `01-01` … `12-31` | included while the range lasts |

- A last day before the first day spans the turn of the year (`start: "10-01"`, `end: "03-31"`).
- The current range is the latest one that has begun. On 1 January a range starting `01-01`
  shows the new year.
- The value table sums every year over its own range: the current year up to yesterday or today,
  previous years up to their last day. With a rolling end that is the same calendar day as today;
  with a fixed last day (e.g. `12-31`) it is the whole range, so the table shows how much of the
  previous years has been reached so far.

## Writing templates for calculated rows

Each calculated row is a normal Home Assistant template. It is rendered once per year column,
and every series is available as a variable holding its **total for that year**:

- the template variable of each series, shown in the editor next to the series (e.g. `{{ grid }}`)
- `series['grid']` – the same values as a dict
- `days` – number of days summed up, `year`, `label` (e.g. `2025` or `2025/26`), `current` (true
  for the current year)

Examples for series named *Grid*, *Solar* and *Feed-in* (variables `grid`, `solar`, `feed_in`):

| Row | Template | Unit | Decimals |
|---|---|---|---|
| Consumption | `{{ grid + solar - feed_in }}` | | |
| Solar used at home | `{{ solar - feed_in }}` | | |
| Self-sufficiency | `{{ (solar - feed_in) / (grid + solar - feed_in) * 100 }}` | `%` | `0` |
| Self-consumption rate | `{{ (solar - feed_in) / solar * 100 if solar else none }}` | `%` | `0` |
| Consumption per day | `{{ (grid + solar - feed_in) / days }}` | `kWh/day` | `1` |
| Grid cost | `{{ grid * states('input_number.electricity_price') \| float(0) }}` | `€` | `2` |

Tips:

- **Return only the number.** Put the unit and decimals into the fields of the row; the card
  formats the value and compares it with the other years.
- **Missing data:** a series without any value in a year is `none`, and `{{ grid + solar }}` then
  fails (the cell shows ⚠, hover for the error). Use `{{ (grid or 0) + (solar or 0) }}`.
- **Division:** guard against zero with `… if solar else none`; the cell then shows "–".
- **Entities** can be used as well, e.g. a price with `states('…') | float(0)`. The row updates
  when the entity changes.
- **Text** results are shown as they are, without comparison:
  `{{ 'record' if solar > 1000 else 'normal' }}`.

## Examples

Energy up to today with two previous years: three inverters as one series, feed-in below the zero
line and the savings from the solar power used at home as a calculated row (first screenshot):

```yaml
type: custom:ha-comparison-card
title: Energy
end: today
compare_years: [1, 2]
series:
  - name: Solar
    statistics: [sensor.inverter_1_energy, sensor.inverter_2_energy, sensor.inverter_3_energy]
    color: "#ff9800"
  - name: Grid
    statistics: [sensor.grid_import_energy]
    color: "#488fc2"
  - name: Feed-in
    statistics: [sensor.grid_export_energy]
    color: "#8353d1"
    below_zero: true
rows:
  - name: Savings
    icon: mdi:cash-100
    template: "{{ (solar - feed_in) * 0.34 }}"
    unit: €
    decimals: 0
headline: Solar
```

Rain per month for the whole year with two previous years; the current month and today are
included, previous years are drawn and summed up to December (second screenshot):

```yaml
type: custom:ha-comparison-card
title: Rain
end: "12-31"
compare_years: [1, 2]
series:
  - name: Rain
    statistics: [sensor.weather_station_total_rain]
    color: "#0381F9"
headline: Rain
```

Heating season per month, three seasons back:

```yaml
type: custom:ha-comparison-card
title: Heating
start: "10-01"
end: "03-31"
compare_years: [1, 2, 3]
series:
  - name: Gas
    statistics: [sensor.gas_meter]
```

December per day, with the daily costs:

```yaml
type: custom:ha-comparison-card
title: December
start: "12-01"
end: "12-31"
group_by: day
series:
  - name: Grid
    statistics: [sensor.grid_import_energy]
rows:
  - name: Cost
    icon: mdi:currency-eur
    template: "{{ grid * 0.32 }}"
    unit: €
    decimals: 2
```

## Visual editor

- **General:** title, first and last day, one bar per hour/day/month, statistic type.
- **Compare with:** one line per previous year – switch plus opacity in percent.
- **Bars:** one collapsible box per series (name, statistics, template variable, below zero,
  color), move up/down, remove.
- **Value table:** switch for the table and the calculated rows (name, icon, template, unit,
  decimals).
- **Display** (collapsible): chart height, headline value, unit, decimals.

## How it works

- Data comes from `recorder/statistics_during_period` with `period: day` (or `hour`), one request
  per year. The recorder rounds the end of a request up to a whole period, so a month query
  always returns the full month and a day query ending at midnight includes the following day.
  The card therefore always fetches days, drops everything outside the range and sums up by
  itself.
- Days follow the time zone of the Home Assistant server.
- Previous years never change and are cached for the lifetime of the page. The current year is
  reloaded after midnight (and again 20 minutes later, when the last hour has been compiled),
  and every 10 minutes while the range includes today. State updates do not re-render the card.
- A day counts as present when any statistic of the card has a row for it. A missing row is not
  treated as zero.

## Tests

Local tests only (not part of the repository): `tests/` with its own `package.json`; run
`npm install` once and then `npm test`. They cover the date logic, the data pipeline against a
fake recorder, rendering, templates and the editor in jsdom.

## Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1.1 | 2026-09-28 | Fixed last day: the value table sums previous years over their whole range instead of stopping at today's calendar day |
| 0.1.0 | 2026-09-28 | First version |

## License

MIT, see [LICENSE](LICENSE).
