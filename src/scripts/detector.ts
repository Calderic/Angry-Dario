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
    ua: string;
  };
};

const PET_IMAGES: Record<PetState, string> = {
  idle: "/assets/states/dario-idle.png",
  sniff: "/assets/states/dario-sniff.png",
  magnify: "/assets/states/dario-magnify.png",
  laugh: "/assets/states/dario-laugh.png",
  rage: "/assets/states/dario-rage.png",
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
const petImage = el<HTMLImageElement>("#pet-image");
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
const rawUa = el<HTMLElement>("#raw-ua");

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const setPet = (state: PetState, line: string) => {
  petImage.classList.remove("is-sniffing", "is-laughing", "is-raging");
  petImage.src = PET_IMAGES[state];
  petImage.alt = {
    idle: "Q 版审查宠物抱臂盯着屏幕",
    sniff: "Q 版审查宠物趴在地上嗅线索",
    magnify: "Q 版审查宠物用放大镜看线索",
    laugh: "Q 版审查宠物捧腹大笑",
    rage: "Q 版审查宠物火冒三丈跺脚",
  }[state];
  if (state === "sniff") petImage.classList.add("is-sniffing");
  if (state === "laugh") petImage.classList.add("is-laughing");
  if (state === "rage") petImage.classList.add("is-raging");
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

const languageScore = (languages: string[]) => {
  const normalized = languages.map((lang) => lang.toLowerCase());
  const first = normalized[0] ?? "";
  const hasMainland = normalized.some(
    (lang) => lang === "zh-cn" || lang === "zh-hans-cn" || lang === "zh-hans",
  );
  const hasChinese = normalized.some((lang) => lang.startsWith("zh"));

  if (first === "zh-cn" || first === "zh-hans-cn") {
    return makeSignal(
      "languages",
      "navigator.languages 首选语言",
      languages.join(", "),
      22,
      22,
      "强",
      "首选语言直接指向简体中文大陆环境，是浏览器侧强信号。",
    );
  }

  if (hasMainland) {
    return makeSignal(
      "languages",
      "navigator.languages 包含简中",
      languages.join(", "),
      14,
      22,
      "中",
      "语言列表包含 zh-CN/zh-Hans，但不是首位，仍可作为中等证据。",
    );
  }

  if (hasChinese) {
    return makeSignal(
      "languages",
      "navigator.languages 中文变体",
      languages.join(", "),
      5,
      22,
      "弱",
      "中文变体可能来自台湾、香港、新加坡或多语言用户，不能单独判断大陆环境。",
    );
  }

  return makeSignal(
    "languages",
    "navigator.languages",
    languages.join(", ") || "未暴露",
    -6,
    22,
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
      16,
      16,
      "强",
      "浏览器用于日期或数字格式化的默认 locale 指向简体中文大陆语境。",
    );
  }

  if (value.includes("zh")) {
    return makeSignal(
      "intl-locale",
      "Intl 日期/数字 Locale",
      compact,
      5,
      16,
      "弱",
      "默认格式化 locale 是中文变体，但不直接等同于中国大陆。",
    );
  }

  return makeSignal(
    "intl-locale",
    "Intl 日期/数字 Locale",
    compact,
    0,
    16,
    "弱",
    "默认格式化 locale 没有提供中文大陆证据。",
  );
};

const timezoneScore = () => {
  const options = Intl.DateTimeFormat().resolvedOptions();
  const zone = options.timeZone || "未知";
  const offsetMinutes = new Date().getTimezoneOffset();
  const offsetHours = -offsetMinutes / 60;
  const mainlandZones = new Set([
    "Asia/Shanghai",
    "Asia/Chongqing",
    "Asia/Harbin",
    "Asia/Urumqi",
  ]);

  if (mainlandZones.has(zone)) {
    return makeSignal(
      "timezone",
      "IANA 时区",
      `${zone}, UTC${offsetHours >= 0 ? "+" : ""}${offsetHours}`,
      16,
      16,
      "中",
      "IANA 时区直接落在中国大陆常见时区名；VPN 和手动时区会影响该信号。",
    );
  }

  if (offsetMinutes === -480) {
    return makeSignal(
      "timezone",
      "getTimezoneOffset()",
      `${zone}, UTC+8`,
      8,
      16,
      "弱",
      "UTC+8 同时覆盖新加坡、马来西亚、台湾、香港等地区，只能算弱到中等证据。",
    );
  }

  return makeSignal(
    "timezone",
    "时区偏移",
    `${zone}, UTC${offsetHours >= 0 ? "+" : ""}${offsetHours}`,
    -4,
    16,
    "弱",
    "时区不在 UTC+8，对中国大陆环境形成轻微反证。",
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
      5,
      8,
      "弱",
      "格式更接近中文环境习惯，但很多地区也使用年月日或相近数字格式。",
    );
  }

  return makeSignal(
    "format-pattern",
    "日期 / 数字格式",
    value,
    0,
    8,
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
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "HarmonyOS Sans SC",
    "MiSans",
  ];
  const detected = targets.filter(detectFont);
  const mainlandWindows = detected.filter((font) =>
    ["Microsoft YaHei", "Microsoft YaHei UI", "SimSun", "NSimSun", "SimHei", "DengXian"].includes(font),
  );
  const simplifiedApple = detected.filter((font) =>
    ["PingFang SC", "Heiti SC", "Songti SC"].includes(font),
  );
  const cnVendor = detected.filter((font) => ["HarmonyOS Sans SC", "MiSans"].includes(font));

  let score = 0;
  let reason = "未探测到典型简体中文字体；字体探测受浏览器反指纹策略影响。";
  let confidence: Signal["confidence"] = "弱";

  if (mainlandWindows.length > 0) {
    score += 14;
    confidence = "中";
    reason = "探测到微软雅黑/宋体/黑体等简中 Windows 常见字体，是中等证据。";
  }

  if (simplifiedApple.length > 0) {
    score += 8;
    confidence = score >= 14 ? "中" : "弱";
    reason = "探测到苹方简体或 macOS/iOS 简体中文字体，可作为辅助证据。";
  }

  if (cnVendor.length > 0) {
    score += 6;
    confidence = score >= 14 ? "中" : "弱";
    reason = "探测到华为/小米相关中文字体，可作为设备环境辅助证据。";
  }

  if (detected.some((font) => ["Noto Sans CJK SC", "Source Han Sans SC"].includes(font))) {
    score += 5;
    reason = "探测到简体中文 CJK 字体，但这类字体也常见于开发者或多语言系统。";
  }

  return makeSignal(
    "fonts",
    "Canvas 中文字体探测",
    detected.join(", ") || "未命中",
    clamp(score, 0, 20),
    20,
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

  const score = clamp(cnBrowserHits.length * 4 + vendorHits.length * 3, 0, 12);

  if (score > 0) {
    return makeSignal(
      "ua",
      "UA / 厂商弱线索",
      [...new Set([...cnBrowserHits, ...vendorHits])].join(", "),
      score,
      12,
      score >= 8 ? "中" : "弱",
      "User-Agent 或 Client Hints 暗示中文常见浏览器、WebView 或设备厂商，只能作为弱相关信号。",
    );
  }

  return makeSignal(
    "ua",
    "UA / 厂商弱线索",
    `${platform}${brands ? ` · ${brands}` : ""}`,
    0,
    12,
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

const ipScore = (info: IpInfo) => {
  if (info.error) {
    return makeSignal(
      "ip",
      "真实 IP 地理位置",
      `查询失败：${info.error}`,
      0,
      35,
      "强",
      "IP 是强信号，但本次公开接口没有返回结果。",
    );
  }

  const location = [info.country, info.region, info.city].filter(Boolean).join(" / ");

  if (info.country?.toUpperCase() === "CN") {
    return makeSignal(
      "ip",
      "真实 IP 地理位置",
      `${location || "CN"} · ${info.source}`,
      35,
      35,
      "强",
      "公网 IP 国家码为 CN，是当前证据链里最强的大陆网络环境信号。",
    );
  }

  if (["HK", "MO", "TW"].includes(info.country?.toUpperCase() || "")) {
    return makeSignal(
      "ip",
      "真实 IP 地理位置",
      `${location} · ${info.source}`,
      4,
      35,
      "弱",
      "IP 位于中文地区但不是中国大陆，不能按大陆环境处理。",
    );
  }

  return makeSignal(
    "ip",
    "真实 IP 地理位置",
    `${location || "非 CN"} · ${info.source}`,
    -16,
    35,
    "强",
    "公网 IP 国家码不是 CN，对大陆网络环境形成强反证。",
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
  const ipInfo = await fetchIpInfo();
  const signals = [
    ipScore(ipInfo),
    languageScore(languages),
    intlLocaleScore(),
    timezoneScore(),
    formatPatternScore(),
    fontScore(),
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

  let resultVerdict = "未抓到明显大陆环境";
  let resultSummary = "证据不足，宠物开始跺脚。";

  if (score >= 75) {
    resultVerdict = "高概率：中国大陆网络 / 浏览器环境";
    resultSummary = "IP、语言、时区或字体信号高度聚合，证据链很响。";
  } else if (score >= 55) {
    resultVerdict = "中高概率：疑似中国大陆环境";
    resultSummary = "多项线索同向，但仍可能被 VPN、多语言系统或手动设置扰动。";
  } else if (score >= 35) {
    resultVerdict = "混合信号：无法坐实";
    resultSummary = "有一些中文环境线索，但强信号不足。";
  }

  return {
    score,
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
  rawUa.textContent = result.raw.ua;
  renderSignals(result.signals);
};

const setBusy = (busy: boolean) => {
  runButton.disabled = busy;
  resetButton.disabled = busy;
};

const runScan = async () => {
  setBusy(true);
  scanState.textContent = "嗅探中";
  setPet("sniff", "趴下，贴地，开始闻浏览器留下来的味道。");
  await delay(850);

  scanState.textContent = "放大中";
  setPet("magnify", "放大镜就位，语言、时区、字体，一个都别想溜。");
  await delay(500);

  const result = await collectSignals();
  renderResult(result);

  if (result.score >= 55) {
    scanState.textContent = "命中";
    setPet("laugh", "抓到了！证据链开始捧腹大笑。");
  } else {
    scanState.textContent = "未命中";
    setPet("rage", "没抓到，他急了，脚都快跺出置信区间。");
  }

  setBusy(false);
};

const resetScan = () => {
  scanState.textContent = "待命";
  scoreValue.textContent = "--";
  scoreMeter.style.setProperty("--score-fill", "0%");
  verdict.textContent = "尚未审查";
  summary.textContent = "点击开始后，本页会读取浏览器本地环境并请求一次 IP 地理信息。";
  signalList.innerHTML = `
    <article class="signal empty">
      <div>
        <h3>等待第一次审查</h3>
        <p>信号项会按权重、置信度和解释逐条展开。</p>
      </div>
      <span class="points">--</span>
    </article>
  `;
  rawIp.textContent = "--";
  rawLanguages.textContent = "--";
  rawLocale.textContent = "--";
  rawTimezone.textContent = "--";
  rawFonts.textContent = "--";
  rawUa.textContent = "--";
  setPet("idle", "抱臂等待证据。别动，统计学正在热身。");
};

runButton.addEventListener("click", () => {
  void runScan();
});
resetButton.addEventListener("click", resetScan);
