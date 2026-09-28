# Sanfort CRM — Android app

A Capacitor shell around the live CRM at **https://sanfort.sirahagents.com**.
The phone app loads that site; the server keeps doing all the work, so shipping
a change to the website ships it to the app too. No app rebuild needed unless
something in `android/` or `capacitor.config.json` changes.

- **App name:** Sanfort International
- **Package id:** `com.sanfort.crm` (this is permanent once published to Play — changing it later means a new listing)
- **Minimum Android:** 7.0 (API 24)

## Build the APK

Android Studio's bundled Java is used; nothing else needs installing.

**Release build — this is the one to hand out.** It needs the signing-key
password (kept in the school's password manager, never in this repo):

```bash
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
cd android && SANFORT_KEYSTORE_PASSWORD="<password>" ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

**Debug build** — for testing only; slower, and remote debugging is on:

```bash
cd android && ./gradlew assembleDebug
```

After editing `capacitor.config.json` or `mobile/www/`, run `npx cap sync android`
first.

## Signing key

`android/keystore/sanfort-release.jks`, alias `sanfort`, valid until 2053.
It is gitignored, so **back it up somewhere outside this project**. Every
release APK must be signed with it: a phone treats a differently-signed APK as
a different app, so users would have to uninstall before installing the new one.
The password is not stored anywhere in the repo — it is passed in as
`SANFORT_KEYSTORE_PASSWORD` at build time.

## Install on a phone

Copy the APK across and open it. The phone will ask to allow installing from
this source — that is expected for an app not from the Play Store.

## What the native shell adds

Everything else is the website. `android/app/src/main/java/com/sanfort/crm/MainActivity.java`
adds only:

- **Downloads.** PDF receipts and Excel exports save to `/Downloads` with the
  session cookie attached, and a notification when finished.
- **Back button.** Goes back a page; exits only on a second press at the first page.
- **External links.** `tel:`, `mailto:`, `upi:` and other sites open in their own app.
- **Offline notice.** `mobile/www/index.html` is shown if the site can't be reached.

## Changing the icon

Replace `public/logo.png`, regenerate `mobile/assets/` (square icon 1024×1024,
splash 2732×2732), then:

```bash
npx @capacitor/assets generate --android --assetPath mobile/assets
```

## Distribution

Hand `mobile/build/sanfort-crm.apk` to staff directly — WhatsApp, email, or a
Drive link. They tap it to install and allow "install from this source" once.
(WhatsApp sometimes blocks .apk attachments; a Drive link always works.)

Not going to the Play Store for now. If that changes it needs a Play Console
account (one-off $25), a privacy policy URL, and store screenshots — the signed
build above is already in the right shape.

**Keep in mind:** the app points at the live site, so anyone using it is working
on live school data.
