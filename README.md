# PT X Landing Prototype

Static prototype for the first two PT X landing blocks with scroll-controlled frame sequence animation.

## Files

- `index.html` - page markup
- `styles.css` - layout, adaptive behavior, sticky product navigation
- `script.js` - canvas sequence renderer and desktop/mobile Lottie switching
- `pt-x_1.json` - desktop sequence
- `pt-x_1-mobile.json` - mobile sequence for viewports up to 768px

## Local Preview

Run a static server from this folder:

```sh
python3 -m http.server 5173
```

Then open:

```txt
http://localhost:5173/
```

The page can also be opened as `index.html`, but a local server is safer for browsers that restrict local JSON loading.
