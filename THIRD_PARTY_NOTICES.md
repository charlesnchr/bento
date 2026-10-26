# Third-party notices

Bento is MIT licensed (`LICENSE`). It includes or links the following.

## Jot (Apache License 2.0)

Dictation, meeting notes and the assistant window (`Sources/Voice`,
`Sources/VoiceCore`, `helper/`, `Resources/Voice`) are derived from
[Jot](https://github.com/google-gemini/jot-gemini-transcribe-macOS) by Ammaar
Reshi, Copyright 2026 Google LLC, licensed under the Apache License 2.0
(`licenses/Jot-LICENSE`). Files that came from Jot keep their copyright
header; they were modified for Bento (renamed, rewired into Bento's modules,
settings, config file and menu, and extended). Jot is not an officially
supported Google product, and neither is this derivative.

## Swift packages

| Package | Use | License |
|---|---|---|
| [MarkdownUI](https://github.com/gonzalezreal/swift-markdown-ui) with [NetworkImage](https://github.com/gonzalezreal/NetworkImage) and [swift-cmark](https://github.com/swiftlang/swift-cmark) | Markdown in assistant replies | MIT; swift-cmark BSD-2-Clause |
| [SwiftMath](https://github.com/mgriebling/SwiftMath), vendored in `Vendor/SwiftMath` | equations in assistant replies | MIT |
| [FluidAudio](https://github.com/FluidInference/FluidAudio) with its NemoTextProcessing binary | on-device Parakeet transcription | Apache 2.0 |

The release app carries these licences in `Contents/Resources/Licenses`.

## Fonts

- Google Sans Flex and Google Sans Code (`Resources/Voice/Fonts`), Copyright
  Google LLC, SIL Open Font License 1.1 (licence files beside the fonts), used
  unmodified.
- Latin Modern Math (`Resources/Voice/mathFonts.bundle`), GUST Font License
  (`GUST-FONT-LICENSE.txt` beside it).

## Sounds

The earcons in `Resources/Voice/Sounds` are original works from Jot, under its
Apache License 2.0.

## Models

Parakeet models are downloaded on first use by FluidAudio from Hugging Face
under their own licences; none ship in the app.
