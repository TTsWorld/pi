/**
 * @file html.ts —— HTML 实体（如 &amp;、&#x1F600;）的最小化解码工具
 *
 * @description
 * 只覆盖 XML 预定义的五个命名实体与数字（十进制 / 十六进制）实体，
 * 不引入完整的实体表；供逐字符扫描 HTML 的场景增量解码使用。
 */

/** 解码结果：实体对应的文本 + 实体在原串中的总长度（含 & 与 ;）。 */
export interface DecodedHtmlEntity {
	text: string;
	length: number;
}

/** 把合法 Unicode 码点转为字符；非法（非整数、越界）返回 undefined。 */
function decodeCodePoint(codePoint: number): string | undefined {
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
		return undefined;
	}
	return String.fromCodePoint(codePoint);
}

/**
 * 解码单个实体名（不含 & 与 ;)：五个命名实体，或 `#x…` / `#…` 数字形式。
 *
 * @param entity - 实体内容，如 "amp"、"#x41"、"#65"
 * @returns 解码后的文本；无法识别时返回 undefined
 */
export function decodeHtmlEntity(entity: string): string | undefined {
	switch (entity) {
		case "amp":
			return "&";
		case "lt":
			return "<";
		case "gt":
			return ">";
		case "quot":
			return '"';
		case "apos":
			return "'";
	}

	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
	}

	if (entity.startsWith("#")) {
		return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
	}

	return undefined;
}

/**
 * 解码 html 中从 index 处的 `&` 开始的一个 HTML 实体。
 *
 * @param html - 完整 HTML 字符串
 * @param index - `&` 字符所在下标
 * @returns 解码结果（文本 + 占用长度）；不是合法实体或超出长度上限时返回 undefined
 */
export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
	const semicolonIndex = html.indexOf(";", index + 1);
	// 找不到结尾分号、或实体过长（>16 字符）都不视为合法实体
	if (semicolonIndex === -1 || semicolonIndex - index > 16) {
		return undefined;
	}

	const entity = html.slice(index + 1, semicolonIndex);
	const decoded = decodeHtmlEntity(entity);
	if (decoded === undefined) {
		return undefined;
	}

	return { text: decoded, length: semicolonIndex - index + 1 };
}
