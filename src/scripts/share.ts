import { toBlob } from "html-to-image";

const sheet = document.querySelector<HTMLElement>(".sheet");
const shareButton = document.querySelector<HTMLButtonElement>("#share-scan");
const exportButton = document.querySelector<HTMLButtonElement>("#export-png");
const exportNote = document.querySelector<HTMLElement>(".export-note");

let toastTimer = 0;

const toast = (message: string) => {
  let node = document.querySelector<HTMLElement>(".toast");
  if (!node) {
    node = document.createElement("p");
    node.className = "toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node?.classList.remove("show");
  }, 2600);
};

const readResult = () => {
  const score = document.querySelector("#score-value")?.textContent?.trim() || "--";
  const verdict = document.querySelector("#verdict")?.textContent?.trim() || "尚未审查";
  return { score, verdict };
};

const shareText = () => {
  const { score, verdict } = readResult();
  return `【${document.title}】我的大陆环境指数：${score}/100，审查结论：${verdict}。你也来受一次审 →`;
};

const isUserCancel = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const makePng = async (): Promise<Blob> => {
  if (!sheet) throw new Error("找不到报告纸张");
  if (exportNote) {
    exportNote.textContent = `本报告由 ${location.host || "本地环境"} 出具 · 纯属整活`;
  }
  document.body.classList.add("is-exporting");
  try {
    const blob = await toBlob(sheet, {
      pixelRatio: 2,
      backgroundColor: "#fdfcf6",
      skipFonts: true,
    });
    if (!blob) throw new Error("PNG 生成失败");
    return blob;
  } finally {
    document.body.classList.remove("is-exporting");
  }
};

const downloadBlob = (blob: Blob) => {
  const { score } = readResult();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ccfh-审查报告-${score}分.png`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
};

const withBusy = async (button: HTMLButtonElement, task: () => Promise<void>) => {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    await task();
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
};

shareButton?.addEventListener("click", () => {
  void withBusy(shareButton, async () => {
    const text = shareText();
    const url = location.href;

    // 优先带图走系统分享面板（移动端可直达社媒）
    try {
      const blob = await makePng();
      const file = new File([blob], "ccfh-report.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text });
        return;
      }
    } catch (error) {
      if (isUserCancel(error)) return;
    }

    // 退回纯文本分享
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ text, url });
        return;
      }
    } catch (error) {
      if (isUserCancel(error)) return;
    }

    // 最后退回复制文案
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast("分享文案已复制，去社媒粘贴吧");
    } catch {
      toast("分享失败，请手动截图或复制链接");
    }
  });
});

exportButton?.addEventListener("click", () => {
  void withBusy(exportButton, async () => {
    try {
      const blob = await makePng();
      downloadBlob(blob);
      toast("PNG 已生成，请查看下载");
    } catch {
      toast("生成失败，请直接截图");
    }
  });
});
