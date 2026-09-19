/** Origins offered as suggestions. Origin fields are free text: the engine
 *  accepts names, ISO codes and common aliases and rejects anything it cannot
 *  resolve, so this list is a convenience, not a whitelist. */
export const ORIGINS = [
  "China",
  "Vietnam",
  "Mexico",
  "Canada",
  "India",
  "Germany",
  "Japan",
  "Taiwan",
  "South Korea",
  "Thailand",
  "Indonesia",
  "Malaysia",
  "Bangladesh",
  "Cambodia",
  "Philippines",
  "Pakistan",
  "Turkey",
  "Italy",
  "France",
  "United Kingdom",
  "Brazil",
  "Australia",
  "Hong Kong",
] as const;

/** The few shown as one-click links on a code page. */
export const QUICK_ORIGINS = ORIGINS.slice(0, 8);
