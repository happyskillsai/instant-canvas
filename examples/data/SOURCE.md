# Datasets used by the InstantCanvas examples

These files are committed so every example is reproducible offline. All are
redistributable; attribution is preserved below as their licenses require.

## `bike-sharing/` — Bike Sharing Dataset (the demo's spine)

- **What:** Hourly (`hour.csv`, 17,379 rows) and daily (`day.csv`, 731 rows)
  bike-rental counts for Capital Bikeshare, Washington D.C., 2011–2012, with
  weather and calendar context.
- **Source:** Hadi Fanaee-T & João Gama, LIAAD, University of Porto —
  UCI Machine Learning Repository, dataset 275.
  <https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset>
- **License:** CC BY 4.0 (redistribution permitted with attribution).
- **Required citation:** Fanaee-T, Hadi, and Gama, Joao, "Event labeling
  combining ensemble detectors and background knowledge," *Progress in
  Artificial Intelligence* (2013): 1–15, Springer. doi:10.1007/s13748-013-0040-3
- **Column notes:** `temp`/`atemp`/`hum`/`windspeed` are normalized (÷41, ÷50,
  ÷100, ÷67). `season` 1–4 = spring/summer/fall/winter. `weathersit` 1–4 = clear
  → heavy rain/snow. `yr` 0/1 = 2011/2012. `cnt = casual + registered`.

## `flare.json` — class hierarchy (supplement for treemap / sunburst / dendrogram)

- **Source:** the Flare / prefuse visualization toolkit, via vega-datasets.
  <https://github.com/vega/vega-datasets/blob/main/data/flare.json>
- **License:** BSD-3-Clause (prefuse/flare); freely redistributed.
- 252 nodes as `{id, name, parent, size?}` — a clean nested tree.

## `miserables.json` — character co-occurrence network (supplement for graph)

- **What:** Co-appearance of characters in *Les Misérables* (Knuth).
- **Source:** vega-datasets.
  <https://github.com/vega/vega-datasets/blob/main/data/miserables.json>
- **License:** public-domain co-occurrence data; freely redistributed.
- 77 nodes + 254 links as `{source, target, value}`, `group` per node.
