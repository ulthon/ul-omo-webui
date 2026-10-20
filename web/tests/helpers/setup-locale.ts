// 测试 preload（vitest.config.ts setupFiles 注册，先于所有测试文件执行）：
// 锁定全部测试运行语言为 zh-CN。现有中文断言依赖默认语言档；此文件防御未来默认档
// 变更或用例间 locale 泄漏，每条用例开始前统一归位，保证既有断言一行不动。
import { beforeEach } from "vitest";
import { useLocaleStore } from "@/i18n/i18n";

useLocaleStore.setState({ locale: "zh-CN" });

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
});
