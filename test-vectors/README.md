# Shared test vectors

`devices.json` holds the device-pairing protocol's vectors (code proof, fingerprint, SPKI hash, pairing links, codes, IPv4 rules, frames, page messages), read by the server's tests (`server/test/devices-*.test.ts`), FremkitKit's (`ios/FremkitKit/Tests/FremkitKitTests/Vectors.swift`) and the Android kit's, so the three implementations answer the same.
Generic data only: a throwaway public key, made-up codes, example addresses (documentation, private and reserved ranges, no personal one), no secret. The IPv4 verdicts are what `inet_pton` says on the Mac (leading zeros taken, as decimal).
Change it with every reader green; the Mac's `WidgetFrames` (native/) does not read `subframes`, since FremkitKit refuses a backslash in a decoded widget path that the Mac's rule lets through.
