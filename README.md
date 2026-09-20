# Catherine & Haolin — Wedding Website

A one-page, bilingual (EN / 中文) wedding invitation site built from the six
invitation illustrations, with a countdown, an interactive map, a
click-to-catch golden snitch, an add-to-calendar button, and a full-screen
photo viewer.

## Preview locally

Just open `index.html` in a browser — no build step, no dependencies.
(Serving it through a local server avoids any browser file:// quirks:)

```bash
# Python
python -m http.server 8000
# or Node
npx serve .
```

Then visit `http://localhost:8000`.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (public, so Pages is free).
2. From this folder:
   ```bash
   git init
   git add .
   git commit -m "Wedding website"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, pick `main` and `/ (root)`, save.
4. Your site will be live at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Customizing

- **Wedding date/time** — `WEDDING_DATE` near the top of `script.js`
  (used for the countdown and the "Add to Calendar" file).
- **Background music** — see `music/README.md`.
- **Text / translations** — every bilingual string in `index.html` lives on
  one element as `data-en="..." data-zh="..."`; edit both.
- **Map hotspot positions** — the three `<button class="hotspot">` elements
  in the Map section use `left`/`top` percentages; nudge them if you want the
  markers to sit exactly on the illustration's labels.
- **RSVP** — not wired up yet. If you want a real RSVP form later, the
  easiest no-backend option is [Formspree](https://formspree.io) (free tier):
  create a form there, then add a `<form action="https://formspree.io/f/xxxx"
  method="POST">` block with your fields to the page.

## Files

```
index.html   structure & bilingual copy
style.css    theme, layout, animations
script.js    countdown, i18n, lightbox, map hotspots, snitch, particles
1.jpg..6.jpg the six invitation illustrations
music/       drop an mp3 here for the background music toggle
```
