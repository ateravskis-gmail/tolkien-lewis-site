# Tolkien / Lewis Pitch Site

Static site (no build step) with local `.mp4` background videos + trailer.

## Deploy on Vercel (recommended for “2nd best” MP4 delivery)

- **Create a new Vercel Project** and import this repo/folder.
- **Framework Preset**: `Other`
- **Build Command**: leave empty
- **Output Directory**: leave empty (Vercel will serve the root)

This repo includes `vercel.json` which:
- **Short-caches HTML** (`/` + `/index.html`) so content changes propagate quickly.
- **Long-caches CSS/JS and MP4s** for best repeat-load performance.

## Cache-busting (important)

`index.html` appends `?v=nar17` to video URLs. When you replace any MP4 file, **bump that version** so visitors don’t get stuck with a cached old video.

## Video optimization checklist (still MP4)

For best playback start time, make sure each MP4 is encoded with **“fast start”** (moov atom at the beginning).

Example (rewrites file in place—consider writing to a new file name instead):

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

If you need better performance on slow connections, the next step up is **adaptive streaming (HLS/DASH)** via a service like Cloudflare Stream or Mux.


