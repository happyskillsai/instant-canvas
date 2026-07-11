# InstantCanvas end-to-end examples

Synthetic data generated for exercising the InstantCanvas skill. Every `*.canvas.json`
here validates against the working-tree CLI and shows up as the "example" collection
in the sidebar when the repo root is the workspace.

| File | Exercises |
|------|-----------|
| 01-marketing-dashboard | kpi cards + deltas, line, stacked bar, funnel, donut, formatted table |
| 02-time-series | line (90d), stacked area, candlestick, themeRiver (real dates), heatmap |
| 03-product-brief | markdown: inline text + two `src` files (frontmatter, task lists, aligned tables, highlighted code) |
| 04-flows-hierarchies | sankey, graph, treemap, sunburst, radar, gauge, parallel, boxplot |
| 05-science-ml | scatter+bubbles, density, violin, errorBars band, scatter3d, surface, contour, splom, dendrogram, silhouette |
| 06-kmeans-sweep | chart sweep — slider over precomputed k-means frames (k=2…6) |
| 07-exec-quarterly | multi-page canvas (tabs), cohort heatmap, revenue bridge |
| 08-annual-report | document mode: cover, TOC, header/footer, theme, back cover — printable |
| 09-project-setup-form | all 16 field types, fieldsets/spans, buttons+pills UI, env destination |
| 10-drop-db-confirm | danger confirm card |

Interactive canvases (09, 10) block `open` until answered in the browser:

```bash
node scripts/instantcanvas.js open example/09-project-setup-form.canvas.json
node scripts/instantcanvas.js open example/10-drop-db-confirm.canvas.json
```
