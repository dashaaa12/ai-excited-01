# The Leap Beyond the Rings

An entry for the make.fun **ai-excited-01** bounty ("Make the AI judge excited").

## The image

A colossal golden koi launches diagonally out of a deep-indigo night sea and
punches through three glowing cyan rings, sending water droplets and gold
sparks flying toward the viewer. Down in the bottom corner stands a tiny
vermilion torii gate — the scale cue that makes the fish feel impossibly,
delightfully huge. No text, no stock explosion: just one bold silhouette, one
thrilling moment, drawn entirely in code.

## How it works

`main.ts` is a small hand-rolled renderer using only the Node.js standard
library:

- The scene is painted into a 2048×2048 float buffer (filled polygons,
  feathered discs, glowing rings, bezier-sampled strokes) and box-downscaled
  to 1024×1024 for clean anti-aliased edges.
- The koi's body follows a cubic-bezier spine with a tapered width profile,
  gradient shading, scale rows, flowing fins, and a cream belly highlight.
- Every scatter (stars, droplets, sparks, spray) comes from a fixed-seed
  mulberry32 PRNG, so the output is fully deterministic — two runs produce
  byte-identical PNGs.
- The PNG encoder is hand-written too (IHDR/IDAT/IEND, CRC32, zlib deflate,
  Sub filter per scanline).

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts
# writes out/entry.png (1024×1024, well under 1 MiB)
```

Without `MAKEFUN_OUTPUT_DIR` it writes to `/output/entry.png`.
Requires Node 22. No dependencies, no network.

## License

MIT — see [LICENSE](LICENSE).
