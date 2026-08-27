/**
 * @file OAuth 授权结果页面的 HTML 生成
 *
 * @description 各 OAuth 流在本地起一个临时 server 接收授权回调；回调处理完成后，
 * 用本文件生成的 HTML 作为响应体，在浏览器中向用户展示登录成功或失败的结果
 * （含 Logo、标题、消息与可选的错误详情），避免用户停在空白或无法展示的回调地址上。
 */

// 内联的白色 Logo（SVG），随页面一并返回，无需额外发起网络请求
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"/><path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/></svg>`;

/**
 * 转义 HTML 特殊字符。
 * 所有要插入页面的动态文本都必须先经过本函数，防止内容被浏览器当作标记解析（XSS 防护）。
 * @param value 原始文本
 * @returns 转义了 & < > " ' 后的安全文本
 */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * 渲染完整的授权结果页面（暗色主题的独立 HTML 文档）。
 * 动态文案先经 escapeHtml 转义再插入模板；details 以等宽字体单独展示，便于阅读和复制错误信息。
 * @param options 页面文案：浏览器标签页标题、主标题、正文消息、可选的详情文本
 * @returns 完整 HTML 文档字符串（样式内联，无外部资源依赖）
 */
function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

/**
 * 渲染「认证成功」页面，作为本地回调 server 的成功响应体返回给浏览器。
 * @param message 展示给用户的成功说明
 * @returns 完整 HTML 文档字符串
 */
export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

/**
 * 渲染「认证失败」页面，作为本地回调 server 的失败响应体返回给浏览器。
 * @param message 失败原因摘要
 * @param details 可选的详细错误信息（以等宽字体块展示）
 * @returns 完整 HTML 文档字符串
 */
export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}
