/** What the Mac shows the phone and the user: the pairing QR text and the code to compare. Browser-safe. */
import type { PairingCode } from './refs.ts'

/** `ultimate-pair:` and the code's JSON as base64url. */
export const pairingQr = (code: PairingCode) =>
  `ultimate-pair:${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(code))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')}`

/** What the user compares between the Mac and the phone before allowing it: the start of the phone's id, as `ABC·DEF`. */
export const verificationCode = (device: string) => `${device.slice(0, 3)}·${device.slice(3, 6)}`
