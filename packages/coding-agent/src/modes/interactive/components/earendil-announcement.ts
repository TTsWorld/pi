/**
 * @file earendil-announcement.ts —— 「pi 加入 Earendil」公告组件
 *
 * @description
 * 一次性公告横幅：动态边框内展示公告标题与博文链接，
 * 并尽量加载随包分发的图片（clankolas.png，base64 内联），
 * 图片缺失时静默跳过。
 */
import * as fs from "node:fs";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { getBundledInteractiveAssetPath } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

// 公告指向的博文地址
const BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";
// 随包分发的公告图片文件名
const IMAGE_FILENAME = "clankolas.png";

/** 图片 base64 缓存；加载失败时保持 undefined */
let cachedImageBase64: string | undefined;
/** 是否已尝试过加载（无论成败只试一次） */
let attemptedImageLoad = false;

/**
 * 惰性加载公告图片并缓存 base64 内容。
 * 只尝试读取一次：失败（如资源未打包）后不再重试，返回 undefined。
 */
function loadImageBase64(): string | undefined {
	if (attemptedImageLoad) {
		return cachedImageBase64;
	}

	attemptedImageLoad = true;
	try {
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
	} catch {
		// 读取失败：保持 undefined，公告仍可正常显示（只是没有图片）
		cachedImageBase64 = undefined;
	}
	return cachedImageBase64;
}

/** 「pi 加入 Earendil」公告横幅组件：标题 + 链接 + 可选图片 */
export class EarendilAnnouncementComponent extends Container {
	constructor() {
		super();

		// 顶部动态边框 + 加粗的公告标题
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi has joined Earendil")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Read the blog post:"), 1, 0));
		this.addChild(new Text(theme.fg("mdLink", BLOG_URL), 1, 0));
		this.addChild(new Spacer(1));

		const imageBase64 = loadImageBase64();
		if (imageBase64) {
			// 图片加载成功：以半角单元格计的固定最大宽度渲染
			this.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			this.addChild(new Spacer(1));
		}

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}
