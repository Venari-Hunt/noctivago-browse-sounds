# Browse Sounds

An official plugin for [Noctívago](https://github.com/Venari-Hunt/Noctivago), the Windows ambient sound mixer. Search and import ambient sounds from Freesound.org, with richer results and infinite scroll (more sources planned).

## Install

In Noctívago, open **Settings > Community plugins > Browse**, pick **Browse Sounds** and click **Install**. Official plugins install even with Restricted mode on.

## Develop

```
npm install
npm run build     # writes main.js
npm test
```

To try a change, copy `manifest.json`, `main.js` and `styles.css` into `%APPDATA%\noctivago-dev\plugins\browse-sounds\` (used by a dev build of the app) and restart the app.

## Layout

```
src/
  index.js       entry: exports the plugin class
  domain/        rules and utilities, no DOM (tested in test/)
  components/    the interface
test/
```

## Release

Bump `version` in `manifest.json`, add it to `versions.json` with its `minAppVersion`, commit, then push a tag equal to the version (`git tag 1.0.1 && git push origin 1.0.1`). The release workflow builds, tests and publishes it.

## License

Apache-2.0
