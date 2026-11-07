# Rollcam

A disposable camera for your iPhone. No previews, no retakes — shoot a roll, send it to the lab, and wait.

**Live app:** https://carposh.github.io/rollcam-new-/

## Add it to your iPhone home screen

1. Open **https://carposh.github.io/rollcam-new-/** in **Safari** (it has to be Safari).
2. Tap the **Share** button (square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**, then tap **Add**.
4. Open **Rollcam** from your home screen. It runs full-screen like a normal app.
5. The first time you load a roll, tap **Allow** when it asks for the camera.

If you denied the camera by mistake: **Settings → Apps → Safari → Camera → Allow** (or **Ask**), then reopen Rollcam and tap the viewfinder.

## How it works

- Load a 24 or 36 exposure roll. Drag the thumbwheel down to wind on after every shot.
- Photos never appear until the roll is developed. When the roll is full, tap **Send to lab**. Use **Develop early** to end a roll now; the unused exposures are thrown away.
- Development takes 24 h by default (1 h / 12 h / 24 h / 3 days in Settings). Setting the clock back won't get your photos back sooner.
- The film look (warm cast, fade, grain, vignette, light leaks, optional orange date stamp) is applied at development time.
- Tap **Save** on a photo (or **Save all** on a roll) and choose **Save Image** in the share sheet to put it in Photos.
- Everything stays on your phone, in IndexedDB. There's no server and no account, and **no backup**: deleting the app from your home screen deletes your rolls.

## Tech

Plain HTML/CSS/JS with no build step, served from the repo root by GitHub Pages. `sw.js` caches the app shell so it opens offline.
