# Missing-icon reports

When the Visual Director (or fallback engine) asks for an icon that does
**not exist** in `static/sketchtalk/sketchtalk-icons.js`, the app:

1. renders a `sticky-note` placeholder on screen, and
2. records the requested name here.

## Files

| File | What it is |
|---|---|
| `missing-icons.json` | Live summary — per icon: how often it was requested, what it was resolved to, and an example transcript |
| `missing-icons.log` | Append-only history with timestamps |

`missing` = icon truly absent (rendered as sticky-note — **these are the ones to draw**).
`fuzzy`  = name was auto-corrected to a similar existing icon (works, but an exact icon would be better).

## How to add an icon

1. Open `static/sketchtalk/sketchtalk-icons.js`
2. Add a new entry in the `ICONS` map with **exactly the reported name** as the key:

```js
'kompor': [
    'M4 10h16v9H4Z',
    'M8 10V7a2 2 0 0 1 4 0',
    'M12.4 13.4h1.2'
],
```

3. Save and reload the page — the server derives its whitelist from this
   file automatically, so the new icon is instantly available to the AI
   (no Python changes needed).

## Tips

- Draw in the 24x24 grid, stroke style is applied automatically
  (width 2, round caps) — just supply path strings.
- Validate with:
  `node -e "require('./static/sketchtalk/sketchtalk-icons.js'); console.log(Object.keys(globalThis.SK_ICONS_LIB.ICONS).length + ' icons')"`
- Keep names lowercase-kebab-case, English, matching the Lucide naming
  style the model already knows.
