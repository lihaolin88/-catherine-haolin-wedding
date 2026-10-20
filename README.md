# Catherine & Haolin — Wedding Website

A one-page, bilingual (EN / 中文) wedding invitation site built from the six
invitation illustrations, with a countdown, a click-to-catch golden snitch,
an add-to-calendar button, a guest questionnaire (RSVP), and a full-screen
photo viewer.

## Preview locally

```bash
pip install openpyxl
python rsvp/dev_server.py
```

Then visit `http://localhost:8000`. The dev server also accepts questionnaire
submissions and writes them to `rsvp/.local/responses.xlsx` (git-ignored, so
test answers never get published).

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
- **RSVP backend** — `RSVP_ENDPOINT` in `script.js`. On localhost it points
  at the dev server; on the live site it points at the Cloudflare Worker in
  `rsvp/worker/` (redeploy with `npx wrangler deploy` from that folder).
  The Worker stores responses in the private repo `lihaolin88/wedding-rsvp`
  (template in `rsvp/data-repo/`), whose GitHub Action rebuilds the Excel file.
  Responses can be viewed at `https://wedding-rsvp.catherine-haolin.workers.dev/admin?key=<ADMIN_KEY>`.

## Releasing a change (cache busting)

WeChat's in-app browser caches pages aggressively. On every release, bump the
same new value in three places: `data-build` on `<html>` and the `?v=` on
`style.css` / `script.js` / the mp3 in `index.html`, plus `BUILD` at the top
of `script.js`. Visitors holding an old copy then reload automatically.

## Files

```
index.html   structure & bilingual copy
style.css    theme, layout, animations
script.js    countdown, i18n, lightbox, RSVP form, snitch, particles
rsvp/        Excel export (xlsx.py) and local dev server (dev_server.py)
1.jpg..6.jpg the six invitation illustrations
music/       drop an mp3 here for the background music toggle
```
