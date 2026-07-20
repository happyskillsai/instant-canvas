# Field notes: reading the bikeshare data

A short tour of the markdown features InstantCanvas renders natively — tables,
task lists, syntax-highlighted code, inline math, and a local image — all from a
plain `.md` file with no canvas envelope. Its cover and theme come from a
**companion canvas** beside it (`field-notes.canvas.json`).

## Seasonal summary

| Season | Avg rides / day | Share |
|--------|----------------:|------:|
| Spring |           2,604 |   14% |
| Summer |           4,992 |   28% |
| Fall   |           5,644 |   32% |
| Winter |           4,728 |   26% |

Fall is the peak, not summer — mild temperatures without the heat.

## Checklist

- [x] Load two years of daily and hourly records
- [x] Fit the demand surface $\hat{y} = f(t, h)$ — reached $R^2 = 0.55$
- [x] Cluster day-types with k-means
- [ ] Add calendar features (holidays, the growth trend)

## A snippet

```python
def r_squared(y, y_hat):
    y_bar = sum(y) / len(y)
    ss_res = sum((a - b) ** 2 for a, b in zip(y, y_hat))
    ss_tot = sum((a - y_bar) ** 2 for a in y)
    return 1 - ss_res / ss_tot
```

## A local image

Workspace-local images are inlined as `data:` URIs server-side — no network fetch:

![Summer palette tile](examples/media/summer.png)
