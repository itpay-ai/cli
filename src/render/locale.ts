export type CardLocale = "zh-CN" | "en";

export function normalizeCardLocale(value: string | undefined): CardLocale {
  switch (value?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "zh":
    case "zh-cn":
    case "zh_cn":
    case "cn":
      return "zh-CN";
    case "en":
    case "en-us":
    case "en_us":
      return "en";
    default:
      throw new Error(`unsupported card locale: ${value}; expected zh-CN or en`);
  }
}

export function localizeCardURL(value: string, locale: CardLocale): string {
  try {
    const parsed = new URL(value);
    parsed.searchParams.set("locale", locale);
    return parsed.toString();
  } catch {
    return value;
  }
}
