# Math rendering showcase

InstantCanvas typesets LaTeX to inline **SVG**, server-side (vendored MathJax), in
the same pass that inlines images — so the browser ships no math engine and
`print` inherits static, theme-following math for free. Open or print this file
directly:

```bash
npx -y @happyskillsai/instant-canvas open  examples/markdown/math-showcase.md
npx -y @happyskillsai/instant-canvas print examples/markdown/math-showcase.md --out math.pdf
```

## Inline math and the literal-dollar guards

The Pearson correlation $r = 0.63$ links temperature to demand, under the model
$\hat{y} = \beta_0 + \beta_1 x$. A price written as $5 or $10 stays literal, and a
`$x$` inside code stays literal too — only real math is typeset.

## Fractions, roots, powers

$$ \frac{\partial \mathcal{L}}{\partial \theta} = \frac{1}{n}\sum_{i=1}^{n}\left(\hat{y}_i - y_i\right)x_i, \qquad \lVert v \rVert = \sqrt{\sum_i v_i^2} $$

## Sums and integrals

$$ \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}, \qquad \sum_{k=1}^{n} k = \frac{n(n+1)}{2} $$

## Matrices

$$ \Sigma = \begin{bmatrix} \sigma_{11} & \sigma_{12} \\ \sigma_{21} & \sigma_{22} \end{bmatrix}, \qquad A^{-1} = \frac{1}{\det A}\,\operatorname{adj}(A) $$

## Aligned systems

$$ \begin{aligned} \nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\ \nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t} \end{aligned} $$

## Cases

$$ f(x) = \begin{cases} x^2 & x \ge 0 \\ -x^2 & x < 0 \end{cases} $$
