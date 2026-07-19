# Math rendering showcase

A stress test of the new server-side LaTeX → inline-SVG math. Everything below is
plain markdown with `$…$`, `$$…$$`, `\(…\)`, and `\[…\]` — rendered once in the
kernel, themed with the surrounding text, and printable.

## Inline math in prose

The area under the Gaussian is $\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}$,
and Euler's identity $e^{i\pi} + 1 = 0$ still feels like a magic trick. The golden
ratio $\varphi = \tfrac{1+\sqrt5}{2}$ satisfies $\varphi^2 = \varphi + 1$, while the
Pythagorean theorem is just \(a^2 + b^2 = c^2\). A deep-descent operator like
$\sum_{k=0}^{n} k$ mid-sentence should sit on the text baseline.

## Fractions, roots, and scripts

$$
\frac{\partial}{\partial x}\left( \frac{x^2 + 1}{\sqrt{x^2 + y^2}} \right)
\qquad
\sqrt[3]{\frac{27 a^3}{8 b^6}} = \frac{3a}{2b^2}
$$

## Sums, products, limits

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
\qquad
\prod_{k=1}^{n} k = n!
\qquad
\lim_{x \to 0} \frac{\sin x}{x} = 1
$$

## Calculus

$$
\frac{d}{dx}\int_{a}^{x} f(t)\,dt = f(x)
\qquad
\int_0^{\pi} \sin x \, dx = 2
\qquad
\nabla \cdot \mathbf{F} = \frac{\partial F_x}{\partial x} + \frac{\partial F_y}{\partial y} + \frac{\partial F_z}{\partial z}
$$

## Matrices — the acid test

A 2×2 matrix inline: $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$, its determinant
$\det = \begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc$.

$$
A = \begin{bmatrix}
1 & 2 & 3 \\
4 & 5 & 6 \\
7 & 8 & 9
\end{bmatrix}
\qquad
A^{-1} = \frac{1}{\det A}\,\mathrm{adj}(A)
\qquad
\begin{pmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{pmatrix}
\begin{pmatrix} x \\ y \end{pmatrix}
$$

An augmented system:

$$
\left[\begin{array}{ccc|c}
1 & 0 & 0 & 3 \\
0 & 1 & 0 & 5 \\
0 & 0 & 1 & 7
\end{array}\right]
$$

## Aligned multi-line derivations

$$
\begin{aligned}
(x+1)^2 &= x^2 + 2x + 1 \\
        &= x^2 + 2x + 1 \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$

## Cases and piecewise definitions

$$
|x| =
\begin{cases}
\;\;x & \text{if } x \ge 0 \\
-x & \text{if } x < 0
\end{cases}
\qquad
\delta_{ij} =
\begin{cases}
1 & i = j \\
0 & i \ne j
\end{cases}
$$

## Probability & statistics

The normal density: $f(x) = \dfrac{1}{\sigma\sqrt{2\pi}}\, e^{-\frac{(x-\mu)^2}{2\sigma^2}}$.

$$
\mathbb{E}[X] = \sum_x x\,p(x)
\qquad
\operatorname{Var}(X) = \mathbb{E}[X^2] - \big(\mathbb{E}[X]\big)^2
\qquad
\binom{n}{k} = \frac{n!}{k!\,(n-k)!}
$$

## Greek, sets, and logic

Greek: $\alpha, \beta, \gamma, \delta, \epsilon, \theta, \lambda, \mu, \pi, \sigma, \phi, \psi, \omega, \Gamma, \Delta, \Omega$.

$$
\forall \varepsilon > 0,\; \exists\, \delta > 0 : |x - a| < \delta \implies |f(x) - f(a)| < \varepsilon
$$

$$
A \cup B, \quad A \cap B, \quad A \subseteq B, \quad x \in \mathbb{R}, \quad \varnothing, \quad \mathbb{Z} \subset \mathbb{Q} \subset \mathbb{R} \subset \mathbb{C}
$$

## Physics

$$
E = mc^2
\qquad
i\hbar \frac{\partial}{\partial t}\Psi = \hat{H}\Psi
\qquad
\oint_{\partial \Sigma} \mathbf{E} \cdot d\boldsymbol{\ell} = -\frac{d\Phi_B}{dt}
$$

## Guard cases (these must NOT render as math)

- A price stays literal: it costs $5 today and \$10 tomorrow.
- A fenced block keeps its dollars verbatim:

```
if (balance < $5) { charge($10); }  # $x$ is literal here
```

- Bad LaTeX degrades visibly instead of breaking the page: $\notacommand{oops}$.

---

*If everything above typeset correctly — matrices aligned, integrals crisp, the
price and the code fence left as plain text, and the bad command shown in red —
the feature is complete.*
