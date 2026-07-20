# Daisly iOS

This is the iOS shell for Daisly. It bundles the Daisly web app into a native iPhone WebView.

## Run on iPhone

1. Open `Daisly.xcodeproj` in Xcode.
2. Select the `Daisly` target.
3. Confirm:
   - Team: `L55G3V9NJ3`
   - Bundle Identifier: `com.daisly.app`
4. Select your connected iPhone.
5. Press Run.

The app bundles the local web files during the Xcode build:

```text
index.html
support.js
ios-frame.jsx
vendor/
uploads/
```

## Before TestFlight

`DaislyWebAppURL` in `Daisly/Info.plist` is only a production HTTPS fallback. The app should normally load the bundled `web/index.html` first.

Expected production values:

```text
Bundle ID: com.daisly.app
Team ID: L55G3V9NJ3
Privacy Policy: https://www.daisly.space/privacy
Terms of Service: https://www.daisly.space/terms
Backend: https://api.daisly.space
```
