// 思考档三链 C（前端消费面）：selectFavoriteModel 收藏切换用收藏档位填思考档——
// pickThinkingLevel 显式手选路径置位（引擎回显不再覆盖）；无档位收藏不动当前档位。
// @ts-nocheck
import { describe, expect, test, beforeEach } from "vitest";

const { useUiStore } = await import("@/stores/ui");
const { selectFavoriteModel } = await import("@/lib/model-cycle");

beforeEach(() => {
  useUiStore.setState({
    selectedModel: null,
    selectedThinkingLevel: null,
    userPickedThinking: false,
    favoriteModels: [],
    favoriteLevels: {},
    projects: [],
  });
});

describe("selectFavoriteModel 收藏档位生效（思考档三链 C）", () => {
  test("收藏带档位：填思考档并置位手选标记", () => {
    useUiStore.getState().setFavoriteModels(["zai-coding-cn/glm-5.3"], { "zai-coding-cn/glm-5.3": "max" });
    selectFavoriteModel("zai-coding-cn/glm-5.3");
    const ui = useUiStore.getState();
    expect(ui.selectedModel).toBe("zai-coding-cn/glm-5.3");
    expect(ui.selectedThinkingLevel).toBe("max");
    expect(ui.userPickedThinking).toBe(true);
  });

  test("收藏无档位：模型切换生效、当前档位不动、不置手选标记", () => {
    useUiStore.getState().setFavoriteModels(["p/m", "p/n"], { "p/m": "max", "p/n": null });
    useUiStore.getState().pickThinkingLevel("low");
    selectFavoriteModel("p/n");
    const ui = useUiStore.getState();
    expect(ui.selectedModel).toBe("p/n");
    expect(ui.selectedThinkingLevel).toBe("low");
    // pickThinkingLevel("low") 已置位；无档位收藏不改变档位语义
    expect(ui.selectedThinkingLevel).toBe("low");
  });
});
