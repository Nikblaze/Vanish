# Illustration sources

- `asl-*.svg`: single handshapes cut from the public-domain ASL fingerspelling chart
  [Asl_alphabet_gallaudet_ann.svg](https://commons.wikimedia.org/wiki/File:Asl_alphabet_gallaudet_ann.svg)
  on Wikimedia Commons (User:Marnanel, after User:Dancor and en:user:Ds13; released into the public domain).
- `room-hand.png`: third-party reference picture for the Room gesture, documentation only, not shipped in the extension.
  `room-hand-bw.png` is the same picture cropped and inverted to black on white (ImageMagick).

`../gen.js` places, rotates and mirrors these into the gesture illustrations: `node docs/gestures/gen.js`.
