// Which column names count as "identifies the owner or their network".
//
// Kept out of the scanner so it can be tested on names a sample database does
// not happen to contain: a rule that only ever sees the four columns of the
// current samples is a rule nobody has checked.
//
// The name is normalised first. Matching the raw name meant `wifiSsid`,
// `androidId` and `serialNo` — the spellings a ROM actually uses — were not
// recognised, because the pattern needs a boundary before the keyword and
// camelCase offers a lowercase letter instead.

const SENSITIVE =
  /(^|_)(ssid|bssid|mac(|_address)|imei|meid|serial(|_no|_number)?|android_id|account|phone|email|latitude|longitude)(_|$)/i;

/** `wifiSsid` -> `wifi_ssid`, `androidID` -> `android_id`, `serialNo` ->
 *  `serial_no`. Existing separators are left alone. */
export function normalizeColumnName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function isSensitiveColumn(name) {
  return SENSITIVE.test(normalizeColumnName(name));
}
