# AI 接入计划

核验日期：2026-09-27。下表描述接口边界；直接 DeepSeek / Claude API 适配器和 Cowork 交接已实现并通过协议测试，真实账号和客户端验证尚未完成。Codex 和 Claude Agent SDK 仍是后续计划。

## 三类适配器

| 类型 | 由谁管理任务循环 | ExplainWeave 提供的体验 |
| --- | --- | --- |
| 直接模型 API | ExplainWeave | 就地流式回答、局部补写、受控工具调用 |
| 可编程 Agent | 外部 Agent 运行时 | 在插件中启动、继续、观察或中止任务 |
| 客户端交接 | 外部应用及用户 | 导出任务包、打开客户端、导入返回草稿 |

共同部分是任务输入、正文版本、草稿结果和解释关联。会话、工具、取消、缓存控制和用量统计由适配器声明具体能力，不用一个虚假的统一聊天接口掩盖差异。

## DeepSeek

作为第一个直接模型后端。官方工具调用示例使用 OpenAI SDK 和 `https://api.deepseek.com`；工具执行仍由应用负责。不同 API 格式对消息和工具的支持存在差异，因此锁定实际使用的端点并做协议测试，不声称支持任意 OpenAI 参数。[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)

优先支持流式生成、取消、结构化草稿及输入/输出用量。读取可用的 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`，比较编辑前后实际开销。缓存属于服务端尽力提供的能力，不能保证第二次调用或任意局部修改都命中。[Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)

模型名称和能力可配置，不把当前模型列表、价格或上下文上限硬编码为永久规则。

## Claude API 与 Claude Agent SDK

Claude API 是直接模型后端，应用负责组装消息与调用工具；Agent SDK 则提供可编程 Agent 循环，适用于需要工具、会话恢复和权限控制的任务。二者均不等于控制 Cowork 桌面窗口。[Claude API](https://platform.claude.com/docs/en/api/overview) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

默认按照官方支持的 API 凭据接入；Agent SDK 的其他认证方式在实际实现时单独核验。SDK 文档对第三方产品提供 claude.ai 登录和订阅额度有单独约束，不能因为用户安装了 Cowork 就承诺插件可以直接复用其订阅。API 后端和客户端交接在设置中明确区分。

## Codex

深度集成优先验证本地 App Server：官方文档为自定义客户端提供认证、会话历史、审批与流式事件；stdio 是默认传输。适配器按安装的 Codex 版本生成或校验协议，处理启动、继续、取消、审批和进程退出。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

当前文档仍将 app-server 命令及 WebSocket 传输标为实验性。首版验证本地 stdio，不依赖远程监听；该集成标为实验功能，验证通过后再明确支持版本。不能承诺控制任意已打开的 Codex 窗口，或完全控制其内部上下文压缩。

## Claude Cowork

官方支持从第三方工具打开新 Cowork 会话并预填输入、附加文件或文件夹：

```text
claude://cowork/new?q=...&folder=...&file=...
```

链接参数须编码，提示长度有限，附加目录会触发 Claude 自己的确认。因此将正文放在任务包中，链接只承载简短指令与文件位置。该入口提供客户端交接；文档没有在这里提供后台提交、读取流式结果或中止已有会话的控制协议。[Open Claude Desktop with a link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)

计划中的首个闭环：

1. 用户在 ExplainWeave 选择“交给 Cowork”。
2. 导出任务包，包含任务 ID、问题、必要正文、基准版本及约定的返回草稿格式。
3. 打开官方链接，在 Cowork 内发送任务。
4. 用户选择返回文件导入；ExplainWeave 校验版本并显示采用预览。

状态区分已导出、已打开、等待回收、草稿可用。打开客户端不能被计作已提交或执行成功。

后续可提供 MCP 工具，让 Cowork 读取选定内容和提交草稿。官方插件支持在 Cowork 中运行本地 MCP；这是 Cowork 调用我们的工具，不自动构成外部控制 Cowork 的 API。具体安装、访问范围及回流需要实测；不能把本机 localhost 当作可由云端访问的远程 connector。[Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)

## 后端接通的判定

- 实现了适配器、模拟测试通过、真实服务验证通过，是三种不同状态。
- 未配置账号时可以测试协议夹具，不展示“已连接”。
- 直接后端返回流式草稿，客户端交接返回交接状态；界面按实际能力展示。
- 任务结果携带生成依据与来源，所有正文修改经过同一个核心操作入口。
- 版本更新后优先重测协议边界、取消、用量字段和错误恢复。
