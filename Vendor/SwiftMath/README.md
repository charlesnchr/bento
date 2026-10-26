# SwiftMath (vendored)

[SwiftMath](https://github.com/mgriebling/SwiftMath) 1.7.3
(`fa8244ed032f4a1ade4cb0571bf87d2f1a9fd2d7`), MIT licensed (see `LICENSE`), renders
LaTeX in the assistant's replies.

Vendored for one change: the math fonts are looked up in
`Bento.app/Contents/Resources/Voice/mathFonts.bundle` (`MathFontsBundle.swift`)
instead of through SwiftPM's `Bundle.module`, which finds them only on the
machine that built the app. Only Latin Modern Math, the default font, ships
(`Resources/Voice/mathFonts.bundle`, GUST Font License).
