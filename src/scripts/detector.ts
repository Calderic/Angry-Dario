type SignalTone = "positive" | "negative" | "neutral";
type PetState = "idle" | "sniff" | "magnify" | "laugh" | "rage";

type Signal = {
  id: string;
  label: string;
  value: string;
  score: number;
  weight: number;
  confidence: "强" | "中" | "弱";
  tone: SignalTone;
  reason: string;
};

type IpInfo = {
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  asn?: string;
  source?: string;
  error?: string;
};

type ScanResult = {
  score: number;
  verdict: string;
  summary: string;
  signals: Signal[];
  raw: {
    ip: string;
    languages: string;
    locale: string;
    timezone: string;
    fonts: string;
    webrtc: string;
    ua: string;
  };
};

type RtcInfo = {
  supported: boolean;
  localIps: string[];
  publicIps: string[];
  mdns: boolean;
  error?: string;
};

const el = <T extends HTMLElement>(selector: string): T => {
  const target = document.querySelector<T>(selector);
  if (!target) {
    throw new Error(`Missing element: ${selector}`);
  }
  return target;
};

const runButton = el<HTMLButtonElement>("#run-scan");
const resetButton = el<HTMLButtonElement>("#reset-scan");
const petStage = el<HTMLDivElement>("#pet-stage");
const petLine = el<HTMLParagraphElement>("#pet-line");
const scoreValue = el<HTMLSpanElement>("#score-value");
const scoreMeter = el<HTMLDivElement>("#score-meter");
const verdict = el<HTMLParagraphElement>("#verdict");
const summary = el<HTMLParagraphElement>("#summary");
const signalList = el<HTMLDivElement>("#signal-list");
const scanState = el<HTMLSpanElement>("#scan-state");

const rawIp = el<HTMLElement>("#raw-ip");
const rawLanguages = el<HTMLElement>("#raw-languages");
const rawLocale = el<HTMLElement>("#raw-locale");
const rawTimezone = el<HTMLElement>("#raw-timezone");
const rawFonts = el<HTMLElement>("#raw-fonts");
const rawWebrtc = el<HTMLElement>("#raw-webrtc");
const rawUa = el<HTMLElement>("#raw-ua");

const shareButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".share-button"),
);

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// 五张状态图都常驻 DOM，只通过舞台上的 data-state 切换可见的那张，
// 避免每次换 src 触发解码闪烁；新状态出现时会重放一次 pop 入场动画。
const setPet = (state: PetState, line: string) => {
  petStage.dataset.state = state;
  petLine.textContent = line;
};

const classifyTone = (score: number): SignalTone => {
  if (score > 0) return "positive";
  if (score < 0) return "negative";
  return "neutral";
};

const makeSignal = (
  id: string,
  label: string,
  value: string,
  score: number,
  weight: number,
  confidence: Signal["confidence"],
  reason: string,
): Signal => ({
  id,
  label,
  value,
  score,
  weight,
  confidence,
  tone: classifyTone(score),
  reason,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// Claude Code 真实的「中国用户」判定读取的是系统 IANA 时区。
// 这两个是 Claude 侧真正会匹配的大陆时区，命中即等同被官方判定。
const CLAUDE_TIMEZONES = new Set(["Asia/Shanghai", "Asia/Urumqi"]);
// 其余大陆时区名（部分系统/旧数据仍在使用），同样等价于大陆环境。
const CN_TIMEZONES = new Set([
  "Asia/Shanghai",
  "Asia/Urumqi",
  "Asia/Chongqing",
  "Asia/Chungking",
  "Asia/Harbin",
  "Asia/Kashgar",
]);
// 大中华区但非大陆，作为中等偏弱证据。
const GREATER_CN_TIMEZONES = new Set([
  "Asia/Hong_Kong",
  "Asia/Macau",
  "Asia/Taipei",
]);

const escapeText = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char] ?? char;
  });

const LANGUAGE_WEIGHT = 18;

// 简体中文大陆变体：zh-CN / zh-Hans / 裸 zh。
const isHansCN = (lang: string) =>
  lang.startsWith("zh-cn") || lang.includes("hans") || lang === "zh";
// 繁体 / 港澳台变体：zh-TW / zh-HK / zh-MO / Hant，属中文但非大陆。
const isHant = (lang: string) =>
  lang.startsWith("zh-tw") ||
  lang.startsWith("zh-hk") ||
  lang.startsWith("zh-mo") ||
  lang.includes("hant");

const languageScore = (languages: string[]) => {
  const normalized = languages.map((lang) => lang.toLowerCase());
  const first = normalized[0] ?? "";

  if (isHansCN(first)) {
    return makeSignal(
      "languages",
      "navigator.languages 首选语言",
      languages.join(", "),
      LANGUAGE_WEIGHT,
      LANGUAGE_WEIGHT,
      "强",
      "首选语言直接指向简体中文大陆环境，是浏览器侧强信号。",
    );
  }

  if (isHant(first)) {
    return makeSignal(
      "languages",
      "navigator.languages 繁体首选",
      languages.join(", "),
      Math.round(LANGUAGE_WEIGHT * 0.5),
      LANGUAGE_WEIGHT,
      "中",
      "首选语言是繁体/港澳台变体，属中文环境但通常不是大陆，作中等证据。",
    );
  }

  if (normalized.some(isHansCN)) {
    return makeSignal(
      "languages",
      "navigator.languages 包含简中",
      languages.join(", "),
      Math.round(LANGUAGE_WEIGHT * 0.7),
      LANGUAGE_WEIGHT,
      "中",
      "语言列表包含 zh-CN/zh-Hans，但不是首位，仍可作为中等证据。",
    );
  }

  if (normalized.some((lang) => lang.startsWith("zh"))) {
    return makeSignal(
      "languages",
      "navigator.languages 中文变体",
      languages.join(", "),
      Math.round(LANGUAGE_WEIGHT * 0.35),
      LANGUAGE_WEIGHT,
      "弱",
      "中文变体可能来自台湾、香港、新加坡或多语言用户，不能单独判断大陆环境。",
    );
  }

  return makeSignal(
    "languages",
    "navigator.languages",
    languages.join(", ") || "未暴露",
    -6,
    LANGUAGE_WEIGHT,
    "弱",
    "语言列表没有中文线索，对大陆环境判断形成轻微反证。",
  );
};

const intlLocaleScore = () => {
  const dateLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const numberLocale = Intl.NumberFormat().resolvedOptions().locale;
  const compact = `${dateLocale} / ${numberLocale}`;
  const value = compact.toLowerCase();

  if (value.includes("zh-cn") || value.includes("zh-hans")) {
    return makeSignal(
      "intl-locale",
      "Intl 日期/数字 Locale",
      compact,
      8,
      8,
      "中",
      "浏览器用于日期或数字格式化的默认 locale 指向简体中文大陆语境。",
    );
  }

  if (value.includes("zh")) {
    return makeSignal(
      "intl-locale",
      "Intl 日期/数字 Locale",
      compact,
      4,
      8,
      "弱",
      "默认格式化 locale 是中文变体，但不直接等同于中国大陆。",
    );
  }

  return makeSignal(
    "intl-locale",
    "Intl 日期/数字 Locale",
    compact,
    0,
    8,
    "弱",
    "默认格式化 locale 没有提供中文大陆证据。",
  );
};

const TIMEZONE_WEIGHT = 34;

const timezoneScore = () => {
  const options = Intl.DateTimeFormat().resolvedOptions();
  const zone = options.timeZone || "未知";
  const offsetMinutes = new Date().getTimezoneOffset();
  const offsetHours = -offsetMinutes / 60;
  const value = `${zone}, UTC${offsetHours >= 0 ? "+" : ""}${offsetHours}`;

  if (CLAUDE_TIMEZONES.has(zone)) {
    return makeSignal(
      "timezone",
      "IANA 时区（Claude 判定字段）",
      value,
      TIMEZONE_WEIGHT,
      TIMEZONE_WEIGHT,
      "强",
      "Claude Code 真实的大陆判定就是读取该时区并匹配 Asia/Shanghai / Asia/Urumqi；命中即等同被官方判定，是整条证据链里最关键的一项。",
    );
  }

  if (CN_TIMEZONES.has(zone)) {
    return makeSignal(
      "timezone",
      "IANA 时区",
      value,
      TIMEZONE_WEIGHT,
      TIMEZONE_WEIGHT,
      "强",
      "时区落在中国大陆时区名，等同大陆系统环境；Claude 主要匹配 Asia/Shanghai / Asia/Urumqi，但大陆环境几乎都会被判定。",
    );
  }

  if (GREATER_CN_TIMEZONES.has(zone)) {
    return makeSignal(
      "timezone",
      "IANA 时区",
      value,
      Math.round(TIMEZONE_WEIGHT * 0.6),
      TIMEZONE_WEIGHT,
      "中",
      "时区位于香港 / 澳门 / 台北，属大中华区但非大陆；Claude 的大陆判定通常不会命中，仅作中等证据。",
    );
  }

  if (offsetMinutes === -480) {
    return makeSignal(
      "timezone",
      "时区偏移 UTC+8",
      value,
      Math.round(TIMEZONE_WEIGHT * 0.35),
      TIMEZONE_WEIGHT,
      "弱",
      "偏移是 UTC+8 但时区名不是大陆，也覆盖新加坡、马来西亚等地，且不匹配 Claude 检查的时区名，只能算弱证据。",
    );
  }

  return makeSignal(
    "timezone",
    "IANA 时区",
    value,
    -8,
    TIMEZONE_WEIGHT,
    "中",
    "时区既不在大陆也不在 UTC+8，Claude 的大陆判定不会命中，对大陆环境形成明确反证。",
  );
};

const formatPatternScore = () => {
  const sampleDate = new Date(2026, 6, 4, 13, 5, 9);
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(sampleDate);
  const formattedNumber = new Intl.NumberFormat(undefined).format(1234567.89);
  const value = `${formattedDate} · ${formattedNumber}`;
  const startsWithYear = /^2026[/-]/.test(formattedDate);
  const hasChineseDate = /年|月|日/.test(formattedDate);

  if (startsWithYear || hasChineseDate) {
    return makeSignal(
      "format-pattern",
      "日期 / 数字格式",
      value,
      3,
      3,
      "弱",
      "格式更接近中文环境习惯，但很多地区也使用年月日或相近数字格式。",
    );
  }

  return makeSignal(
    "format-pattern",
    "日期 / 数字格式",
    value,
    0,
    3,
    "弱",
    "默认格式没有明显中文大陆线索。",
  );
};

const detectFont = (fontName: string) => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;

  const text = "mmmmmmmmmmlli汉字简体繁體ABC12345";
  const bases = ["monospace", "serif", "sans-serif"];
  const size = "72px";

  return bases.some((base) => {
    context.font = `${size} ${base}`;
    const baseWidth = context.measureText(text).width;
    context.font = `${size} "${fontName}", ${base}`;
    const testWidth = context.measureText(text).width;
    return Math.abs(testWidth - baseWidth) > 0.5;
  });
};

const fontScore = () => {
  const targets = [
    "Microsoft YaHei",
    "Microsoft YaHei UI",
    "SimSun",
    "NSimSun",
    "SimHei",
    "DengXian",
    "FangSong",
    "KaiTi",
    "PingFang SC",
    "Heiti SC",
    "Songti SC",
    "Hiragino Sans GB",
    "STHeiti",
    "STSong",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "Source Han Sans CN",
    "WenQuanYi Micro Hei",
    "HarmonyOS Sans SC",
    "MiSans",
  ];
  const detected = targets.filter(detectFont);
  const mainlandWindows = detected.filter((font) =>
    ["Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "NSimSun", "SimHei", "DengXian"].includes(font),
  );
  const simplifiedApple = detected.filter((font) =>
    ["PingFang SC", "Heiti SC", "Songti SC", "Hiragino Sans GB", "STHeiti", "STSong"].includes(font),
  );
  const cnVendor = detected.filter((font) => ["HarmonyOS Sans SC", "MiSans"].includes(font));

  const FONT_WEIGHT = 14;
  let score = 0;
  let reason = "未探测到典型简体中文字体；字体探测受浏览器反指纹策略影响。";
  let confidence: Signal["confidence"] = "弱";

  if (mainlandWindows.length > 0) {
    score += 10;
    confidence = "中";
    reason = "探测到微软雅黑/宋体/黑体等简中 Windows 常见字体，是中等证据。";
  }

  if (simplifiedApple.length > 0) {
    score += 6;
    confidence = score >= 10 ? "中" : "弱";
    reason = "探测到苹方简体或 macOS/iOS 简体中文字体，可作为辅助证据。";
  }

  if (cnVendor.length > 0) {
    score += 4;
    confidence = score >= 10 ? "中" : "弱";
    reason = "探测到华为/小米相关中文字体，可作为设备环境辅助证据。";
  }

  if (detected.some((font) =>
    ["Noto Sans CJK SC", "Source Han Sans SC", "Source Han Sans CN", "WenQuanYi Micro Hei"].includes(font),
  )) {
    score += 3;
    reason = "探测到简体中文 CJK 字体，但这类字体也常见于开发者或多语言系统。";
  }

  return makeSignal(
    "fonts",
    "Canvas 中文字体探测",
    detected.join(", ") || "未命中",
    clamp(score, 0, FONT_WEIGHT),
    FONT_WEIGHT,
    confidence,
    reason,
  );
};

const uaScore = () => {
  const nav = navigator as Navigator & {
    userAgentData?: {
      brands?: { brand: string; version: string }[];
      mobile?: boolean;
      platform?: string;
    };
  };
  const ua = navigator.userAgent;
  const brands = nav.userAgentData?.brands?.map((item) => item.brand).join(", ") ?? "";
  const platform = nav.userAgentData?.platform || navigator.platform || "未知";
  const haystack = `${ua} ${brands} ${platform}`.toLowerCase();
  const cnBrowserHits = [
    "micromessenger",
    "mqqbrowser",
    "qqbrowser",
    "quark",
    "ucbrowser",
    "huawei",
    "huaweibrowser",
    "miuibrowser",
    "heytapbrowser",
    "baidubrowser",
    "sogoumobilebrowser",
    "alipayclient",
    "dingtalk",
  ].filter((needle) => haystack.includes(needle));
  const vendorHits = ["harmonyos", "huawei", "honor", "xiaomi", "miui", "oppo", "vivo", "realme"].filter(
    (needle) => haystack.includes(needle),
  );

  const UA_WEIGHT = 3;
  const score = clamp(cnBrowserHits.length * 2 + vendorHits.length, 0, UA_WEIGHT);

  if (score > 0) {
    return makeSignal(
      "ua",
      "UA / 厂商弱线索",
      [...new Set([...cnBrowserHits, ...vendorHits])].join(", "),
      score,
      UA_WEIGHT,
      "弱",
      "User-Agent 或 Client Hints 暗示中文常见浏览器、WebView 或设备厂商，只能作为弱相关信号。",
    );
  }

  return makeSignal(
    "ua",
    "UA / 厂商弱线索",
    `${platform}${brands ? ` · ${brands}` : ""}`,
    0,
    UA_WEIGHT,
    "弱",
    "UA 没有命中中文常见浏览器或设备厂商关键词。",
  );
};

const fetchJson = async <T>(url: string, timeoutMs = 4500): Promise<T> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
};

const fetchIpInfo = async (): Promise<IpInfo> => {
  try {
    const data = await fetchJson<{
      ip?: string;
      country_code?: string;
      country?: string;
      region?: string;
      city?: string;
      org?: string;
      asn?: string;
    }>("https://ipapi.co/json/");

    return {
      ip: data.ip,
      country: data.country_code || data.country,
      region: data.region,
      city: data.city,
      asn: data.org || data.asn,
      source: "ipapi.co",
    };
  } catch (firstError) {
    try {
      const data = await fetchJson<{ ip?: string; country?: string }>("https://api.country.is/");
      return {
        ip: data.ip,
        country: data.country,
        source: "api.country.is",
      };
    } catch (secondError) {
      const message =
        secondError instanceof Error
          ? secondError.message
          : firstError instanceof Error
            ? firstError.message
            : "IP lookup failed";
      return { error: message, source: "failed" };
    }
  }
};

const IP_WEIGHT = 20;

const ipScore = (info: IpInfo) => {
  if (info.error) {
    return makeSignal(
      "ip",
      "真实 IP 地理位置",
      `查询失败：${info.error}`,
      0,
      IP_WEIGHT,
      "中",
      "IP 是佐证信号，但本次公开接口没有返回结果。",
    );
  }

  const location = [info.country, info.region, info.city].filter(Boolean).join(" / ");

  if (info.country?.toUpperCase() === "CN") {
    return makeSignal(
      "ip",
      "真实 IP 地理位置",
      `${location || "CN"} · ${info.source}`,
      IP_WEIGHT,
      IP_WEIGHT,
      "强",
      "公网 IP 国家码为 CN，佐证真实身处大陆网络；但 Claude 侧真正判定靠的是系统时区，IP 仅作补强。",
    );
  }

  if (["HK", "MO", "TW"].includes(info.country?.toUpperCase() || "")) {
    return makeSignal(
      "ip",
      "真实 IP 地理位置",
      `${location} · ${info.source}`,
      Math.round(IP_WEIGHT * 0.15),
      IP_WEIGHT,
      "弱",
      "IP 位于中文地区但不是中国大陆，不能按大陆环境处理。",
    );
  }

  return makeSignal(
    "ip",
    "真实 IP 地理位置",
    `${location || "非 CN"} · ${info.source}`,
    -6,
    IP_WEIGHT,
    "中",
    "公网 IP 国家码不是 CN，形成温和反证；但代理 / VPN 常让身处大陆者显示境外 IP，此时系统时区仍可能触发 Claude 判定，故不作强反证。",
  );
};

// 通过 RTCPeerConnection 收集 ICE 候选，抖出浏览器真实的本地 / 公网出口。
// 现代浏览器会用 mDNS（*.local）掩盖局域网地址，公网候选则来自 STUN 反射。
const gatherWebRtc = async (timeoutMs = 2200): Promise<RtcInfo> => {
  const RTCPeer =
    window.RTCPeerConnection ||
    (window as unknown as { webkitRTCPeerConnection?: typeof RTCPeerConnection })
      .webkitRTCPeerConnection;

  if (!RTCPeer) {
    return {
      supported: false,
      localIps: [],
      publicIps: [],
      mdns: false,
      error: "浏览器未提供 RTCPeerConnection",
    };
  }

  return await new Promise<RtcInfo>((resolve) => {
    const localIps = new Set<string>();
    const publicIps = new Set<string>();
    let mdns = false;
    let settled = false;
    let pc: RTCPeerConnection;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // 忽略关闭异常
      }
      resolve({
        supported: true,
        localIps: [...localIps],
        publicIps: [...publicIps],
        mdns,
      });
    };

    try {
      pc = new RTCPeer({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    } catch (error) {
      resolve({
        supported: false,
        localIps: [],
        publicIps: [],
        mdns: false,
        error: error instanceof Error ? error.message : "RTC 初始化失败",
      });
      return;
    }

    const ipRegex = /(?:\d{1,3}\.){3}\d{1,3}|(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+/i;

    pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) {
        if (!event.candidate) finish();
        return;
      }
      const candidate = event.candidate.candidate;
      if (candidate.includes(".local")) {
        mdns = true;
        return;
      }
      const parts = candidate.split(" ");
      const ip = parts[4] ?? "";
      const typIndex = parts.indexOf("typ");
      const type = typIndex >= 0 ? parts[typIndex + 1] : "";
      if (!ipRegex.test(ip)) return;
      if (type === "srflx" || type === "prflx") {
        publicIps.add(ip);
      } else {
        localIps.add(ip);
      }
    };

    const timer = window.setTimeout(finish, timeoutMs);

    try {
      pc.createDataChannel("ccfh-probe");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish());
    } catch {
      finish();
    }
  });
};

const WEBRTC_WEIGHT = 4;

const webrtcScore = (rtc: RtcInfo, info: IpInfo) => {
  if (!rtc.supported) {
    return makeSignal(
      "webrtc",
      "WebRTC 出口穿透",
      rtc.error || "浏览器未开放 WebRTC",
      0,
      WEBRTC_WEIGHT,
      "弱",
      "浏览器禁用或不支持 WebRTC，拿不到额外的网络出口线索。",
    );
  }

  const httpIp = info.error ? "" : info.ip || "";
  const hasPublic = rtc.publicIps.length > 0;
  const leakedPublic = rtc.publicIps.join(", ");
  const localSummary = rtc.mdns
    ? "本地地址被 mDNS 掩盖"
    : rtc.localIps.length
      ? `本地 ${rtc.localIps.join(", ")}`
      : "未暴露本地地址";

  // 公网候选与网页看到的 IP 不一致 —— 典型的代理 / VPN 分流特征。
  if (hasPublic && httpIp && !rtc.publicIps.includes(httpIp)) {
    return makeSignal(
      "webrtc",
      "WebRTC 出口穿透",
      `${leakedPublic}（网页 IP ${httpIp}）· ${localSummary}`,
      Math.round(WEBRTC_WEIGHT * 0.5),
      WEBRTC_WEIGHT,
      "中",
      "WebRTC 暴露的公网出口和网页 IP 对不上，是代理 / VPN 分流的典型特征——IP 能换，但系统时区照样会把大陆环境抖出来。",
    );
  }

  if (hasPublic) {
    return makeSignal(
      "webrtc",
      "WebRTC 出口穿透",
      `${leakedPublic} · ${localSummary}`,
      0,
      WEBRTC_WEIGHT,
      "弱",
      "WebRTC 公网出口与网页 IP 一致，看起来是直连，没有额外代理线索。",
    );
  }

  if (rtc.mdns || rtc.localIps.length) {
    return makeSignal(
      "webrtc",
      "WebRTC 出口穿透",
      `${localSummary} · 无公网候选`,
      0,
      WEBRTC_WEIGHT,
      "弱",
      "只拿到本地候选、没有公网出口：可能是隐私加固，也可能是 STUN 被网络拦截（大陆常见），信号偏弱。",
    );
  }

  return makeSignal(
    "webrtc",
    "WebRTC 出口穿透",
    "未收集到任何候选",
    0,
    WEBRTC_WEIGHT,
    "弱",
    "没有收集到任何 ICE 候选，可能被浏览器策略或网络环境完全拦截。",
  );
};

const collectSignals = async (): Promise<ScanResult> => {
  const nav = navigator as Navigator & {
    userAgentData?: {
      brands?: { brand: string; version: string }[];
      mobile?: boolean;
      platform?: string;
    };
  };
  const languages = navigator.languages?.length ? [...navigator.languages] : [navigator.language].filter(Boolean);
  const [ipInfo, rtcInfo] = await Promise.all([fetchIpInfo(), gatherWebRtc()]);
  const signals = [
    ipScore(ipInfo),
    languageScore(languages),
    intlLocaleScore(),
    timezoneScore(),
    formatPatternScore(),
    fontScore(),
    webrtcScore(rtcInfo, ipInfo),
    uaScore(),
  ];
  const maxScore = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const rawScore = signals.reduce((sum, signal) => sum + signal.score, 0);
  const score = clamp(Math.round((rawScore / maxScore) * 100), 0, 100);
  const detectedFonts = signals.find((signal) => signal.id === "fonts")?.value ?? "--";
  const timeOptions = Intl.DateTimeFormat().resolvedOptions();
  const offset = new Date().getTimezoneOffset();
  const platform = nav.userAgentData?.platform || navigator.platform || "未知";
  const brands = nav.userAgentData?.brands
    ?.map((brand) => `${brand.brand} ${brand.version}`)
    .join(", ");

  // Claude Code 的大陆判定核心就是系统 IANA 时区。命中它真正匹配的时区名，
  // 无论 IP / 语言如何，都应视为「会被判定」，直接顶到高概率档。
  const currentZone = timeOptions.timeZone || "";
  const claudeTimezoneHit = CLAUDE_TIMEZONES.has(currentZone);
  const cnTimezoneHit = CN_TIMEZONES.has(currentZone);

  let resultVerdict = "未抓到明显大陆环境";
  let resultSummary = "证据不足，宠物开始跺脚。";

  if (claudeTimezoneHit || cnTimezoneHit || score >= 72) {
    resultVerdict = "高概率：中国大陆网络 / 浏览器环境";
    resultSummary = claudeTimezoneHit
      ? `系统时区为 ${currentZone}，正是 Claude Code 大陆判定直接匹配的时区名——即便用代理换了 IP，这一项也足以被判定。`
      : cnTimezoneHit
        ? `系统时区落在大陆时区（${currentZone}），是 Claude 侧最关键的判定字段，几乎必然被判定。`
        : "时区、语言、字体等信号高度聚合，证据链很响。";
  } else if (score >= 52) {
    resultVerdict = "中高概率：疑似中国大陆环境";
    resultSummary = "多项线索同向，但仍可能被 VPN、多语言系统或手动设置扰动。";
  } else if (score >= 32) {
    resultVerdict = "混合信号：无法坐实";
    resultSummary = "有一些中文环境线索，但强信号不足。";
  }

  const effectiveScore = (claudeTimezoneHit || cnTimezoneHit) ? Math.max(score, 78) : score;

  return {
    score: effectiveScore,
    verdict: resultVerdict,
    summary: resultSummary,
    signals,
    raw: {
      ip: ipInfo.error
        ? `查询失败：${ipInfo.error}`
        : `${ipInfo.ip || "IP 未返回"} · ${[ipInfo.country, ipInfo.region, ipInfo.city]
            .filter(Boolean)
            .join(" / ")} · ${ipInfo.asn || ipInfo.source || ""}`,
      languages: languages.join(", ") || "未暴露",
      locale: `${Intl.DateTimeFormat().resolvedOptions().locale} · ${Intl.NumberFormat().resolvedOptions().locale}`,
      timezone: `${timeOptions.timeZone || "未知"} · getTimezoneOffset=${offset}`,
      fonts: detectedFonts,
      webrtc: !rtcInfo.supported
        ? rtcInfo.error || "不支持"
        : [
            rtcInfo.publicIps.length ? `公网 ${rtcInfo.publicIps.join(", ")}` : "无公网候选",
            rtcInfo.mdns
              ? "本地被 mDNS 掩盖"
              : rtcInfo.localIps.length
                ? `本地 ${rtcInfo.localIps.join(", ")}`
                : "无本地候选",
          ].join(" · "),
      ua: `${platform}${brands ? ` · ${brands}` : ""} · ${navigator.userAgent}`,
    },
  };
};

const renderSignals = (signals: Signal[]) => {
  signalList.innerHTML = signals
    .map(
      (signal) => {
        const fill = signal.weight === 0 ? 0 : Math.round((Math.abs(signal.score) / signal.weight) * 100);

        return `
        <article class="signal ${signal.tone}" style="--signal-fill: ${clamp(fill, 0, 100)}%">
          <div class="signal-main">
            <h3>${escapeText(signal.label)}</h3>
            <p><strong>${escapeText(signal.value)}</strong>。${escapeText(signal.reason)}</p>
            <div class="meta">
              <span>置信度 ${signal.confidence}</span>
              <span>权重 ${signal.weight}</span>
              <span>${escapeText(signal.id)}</span>
            </div>
          </div>
          <span class="points">${signal.score > 0 ? "+" : ""}${signal.score}</span>
        </article>
      `;
      },
    )
    .join("");
};

const renderResult = (result: ScanResult) => {
  scoreValue.textContent = String(result.score);
  scoreMeter.style.setProperty("--score-fill", `${result.score}%`);
  verdict.textContent = result.verdict;
  summary.textContent = result.summary;
  rawIp.textContent = result.raw.ip;
  rawLanguages.textContent = result.raw.languages;
  rawLocale.textContent = result.raw.locale;
  rawTimezone.textContent = result.raw.timezone;
  rawFonts.textContent = result.raw.fonts;
  rawWebrtc.textContent = result.raw.webrtc;
  rawUa.textContent = result.raw.ua;
  renderSignals(result.signals);
  shareButtons.forEach((button) => {
    button.disabled = false;
  });
};

const setBusy = (busy: boolean) => {
  runButton.disabled = busy;
  resetButton.disabled = busy;
};

const runScan = async () => {
  setBusy(true);
  delete document.body.dataset.verdict;

  // 一边贴地左右嗅探，一边真正开始收集 WebRTC / IP（后台并行，收满约需两三秒）
  const resultPromise = collectSignals();

  scanState.textContent = "嗅探中";
  setPet("sniff", "左边闻一鼻子，右边闻一鼻子——语言、时区、字体的味儿全留在浏览器里。");
  await delay(2600);

  scanState.textContent = "放大中";
  setPet("magnify", "放大镜就位，locale、数字格式这些小辫子一根根揪出来。");
  await delay(1700);

  scanState.textContent = "穿透中";
  setPet("magnify", "别以为挂了代理就干净，WebRTC 正把你真实的网络出口一点点抖出来。");

  // 等真实检测收尾（WebRTC 收集若还没到超时，这里会把过程感补足）
  const result = await resultPromise;
  await delay(500);

  renderResult(result);

  if (result.score >= 52) {
    scanState.textContent = "命中";
    document.body.dataset.verdict = "hit";
    setPet("laugh", "抓到了！证据链开始捧腹大笑。");
  } else {
    scanState.textContent = "未命中";
    document.body.dataset.verdict = "miss";
    setPet("rage", "没抓到，他急了，脚都快跺出置信区间。");
  }

  setBusy(false);
};

const resetScan = () => {
  delete document.body.dataset.verdict;
  scanState.textContent = "待命";
  scoreValue.textContent = "--";
  scoreMeter.style.setProperty("--score-fill", "0%");
  verdict.textContent = "尚未审查";
  summary.textContent = "点击开始后，本页会读取浏览器本地环境并请求一次 IP 地理信息。";
  signalList.innerHTML = `
    <article class="signal empty">
      <div class="signal-main">
        <h3>等待第一次审查</h3>
        <p>证据项会按权重、置信度和解释逐条展开。</p>
      </div>
      <span class="points">--</span>
    </article>
  `;
  rawIp.textContent = "--";
  rawLanguages.textContent = "--";
  rawLocale.textContent = "--";
  rawTimezone.textContent = "--";
  rawFonts.textContent = "--";
  rawWebrtc.textContent = "--";
  rawUa.textContent = "--";
  shareButtons.forEach((button) => {
    button.disabled = true;
  });
  setPet("idle", "抱臂等待证据。别动，统计学正在热身。");
};

runButton.addEventListener("click", () => {
  void runScan();
});
resetButton.addEventListener("click", resetScan);
