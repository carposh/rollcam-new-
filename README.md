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

- **Camera tab:** load a 24 or 36 exposure roll, then shoot. The counter shows shots taken (`09 / 24`). The square viewfinder has a soft black-and-white blur by default, so you see the light, not the shot. Tap **B&W blur** on the viewfinder to switch it off or on.
- **Controls:** flash (the real flash on the back camera where iOS allows it, a white-screen flash on the front camera), front/back camera switch, counter, self-timer (Off / 2s / 5s / 10s), and **End roll**, which sends the roll to the lab early and throws away the unused exposures.
- When the roll is full, tap **Send to lab**.
- **Lab tab:** a countdown for each roll. Development takes 24 h by default (1h / 12h / 24h / 3 days in Settings). Setting the clock back won't get your photos back sooner.
- **Rolls tab:** your developed rolls. Tap **Save** on a photo (or **Save all** on a roll) and choose **Save Image** to put it in Photos.
- **Settings:** development time, frame format (4:3 / 3:2 / 1:1), blurred viewfinder, grid, timer, grain, date stamp with format and colour, storage usage, and Delete all data.
- The film look (warm cast, fade, grain, vignette, light leaks, date stamp) is applied only at development time.
- Everything stays on your phone, in IndexedDB. There's no server, no account and **no backup**: deleting the app from your home screen deletes your rolls.

## Tech

Plain HTML/CSS/JS with no build step, served from the repo root by GitHub Pages. `sw.js` caches the app shell so it opens offline.
